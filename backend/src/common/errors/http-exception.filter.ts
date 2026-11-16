import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
} from "@nestjs/common";
import { Request } from "express";
import { requestContext } from "../observability/request-context";

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse();
    const request = ctx.getRequest<Request>();

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    const message =
      exception instanceof HttpException
        ? exception.message
        : "Internal server error";

    const context = requestContext.getStore();
    if (context)
      context.errorClass =
        exception instanceof HttpException
          ? [
              "BadRequestException",
              "UnauthorizedException",
              "ForbiddenException",
              "NotFoundException",
              "ConflictException",
              "ServiceUnavailableException",
              "InternalServerErrorException",
            ].includes(exception.constructor.name)
            ? exception.constructor.name
            : "HttpException"
          : "Error";
    const details =
      exception instanceof HttpException ? exception.getResponse() : undefined;
    const checks =
      typeof details === "object" && details !== null && "checks" in details
        ? (details as { checks: unknown }).checks
        : undefined;
    // Forward only explicitly approved status/code combinations.
    // Never forward arbitrary metadata, credentials or internal codes.
    const allowedCodes: Readonly<Record<number, readonly string[]>> = {
      [HttpStatus.BAD_REQUEST]: ["VALIDATION_ERROR", "INVALID_QUOTA"],
      [HttpStatus.UNAUTHORIZED]: ["UNAUTHORIZED"],
      [HttpStatus.FORBIDDEN]: ["REGISTRATION_DISABLED", "ADMIN_REQUIRED"],
      [HttpStatus.NOT_FOUND]: ["USER_NOT_FOUND"],
      [HttpStatus.CONFLICT]: ["EMAIL_ALREADY_EXISTS"],
      [HttpStatus.SERVICE_UNAVAILABLE]: ["STORAGE_ACCOUNTING_UNAVAILABLE"],
    };

    const adminUserRequest =
      /^\/api\/v1\/admin\/users(?:\/|$)/i.test(request.path ?? "");

    const requestedCode =
      typeof details === "object" &&
      details !== null &&
      "code" in details &&
      typeof details.code === "string"
        ? details.code
        : undefined;

    const safeCode =
      requestedCode !== undefined &&
      allowedCodes[status]?.includes(requestedCode)
        ? requestedCode
        : adminUserRequest && status === HttpStatus.UNAUTHORIZED
          ? "UNAUTHORIZED"
          : undefined;

    const safeChecks =
      checks && typeof checks === "object"
        ? Object.fromEntries(
            ["database", "storage"]
              .filter((key) =>
                ["ok", "unavailable"].includes(
                  (checks as Record<string, string>)[key],
                ),
              )
              .map((key) => [key, (checks as Record<string, string>)[key]]),
          )
        : undefined;

    response.status(status).json({
      statusCode: status,
      ...(safeCode ? { code: safeCode } : {}),
      ...(safeChecks ? { checks: safeChecks } : {}),
      message,
      timestamp: new Date().toISOString(),
      // Administrative query parameters may contain user-supplied
      // search terms or unexpected fields. Do not reflect them.
      path: adminUserRequest ? request.path : request.url,
    });
  }
}

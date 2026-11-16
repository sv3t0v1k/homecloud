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
    // Do not forward arbitrary exception metadata to clients.
    // Explicitly allow only the stable registration-denial code.
    const safeCode =
      status === HttpStatus.FORBIDDEN &&
      typeof details === "object" &&
      details !== null &&
      "code" in details &&
      details.code === "REGISTRATION_DISABLED"
        ? "REGISTRATION_DISABLED"
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
      path: request.url,
    });
  }
}

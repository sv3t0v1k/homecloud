import { ForbiddenException } from "@nestjs/common";
import { Repository } from "typeorm";
import { UpdatesController } from "./updates.controller";
import { UpdatesService } from "./updates.service";
import { UpdateInstallService } from "./update-install.service";
import { UserEntity, UserRole } from "../entities/user.entity";

describe("UpdatesController", () => {
  const check = jest.fn();
  const status = jest.fn();
  const submit = jest.fn();
  const findOne = jest.fn();
  const updates = {
    isAdmin: (id: number) => id === 7,
    check,
  } as unknown as UpdatesService;
  const install = { status, submit } as unknown as UpdateInstallService;
  const users = { findOne } as unknown as Repository<UserEntity>;
  const controller = new UpdatesController(updates, install, users);
  const dto = { manifestSha256: "a".repeat(64) };

  const actor = (userId = 7, sessionVersion = "1") => ({
    user: { userId, sessionVersion, email: "owner@example.test" },
  } as never);

  const owner = {
    id: 7,
    role: UserRole.ADMIN,
    isActive: true,
    sessionVersion: "1",
  };

  beforeEach(() => {
    jest.clearAllMocks();
    findOne.mockResolvedValue(owner);
  });

  async function assertDenied(req: ReturnType<typeof actor>) {
    await expect(controller.access(req)).resolves.toEqual({ admin: false });
    await expect(controller.check(req)).rejects.toThrow(ForbiddenException);
    await expect(controller.installationStatus(req)).rejects.toThrow(ForbiddenException);
    await expect(controller.requestInstallation(req, dto)).rejects.toThrow(ForbiddenException);
    expect(check).not.toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  }

  it("accepts the configured active administrator", async () => {
    await expect(controller.access(actor())).resolves.toEqual({ admin: true });
    await controller.check(actor());
    await controller.installationStatus(actor());
    await controller.requestInstallation(actor(), dto);
    expect(check).toHaveBeenCalledTimes(1);
    expect(status).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith(dto.manifestSha256);
  });

  it("rejects another authenticated administrator", async () => {
    await assertDenied(actor(8));
    expect(findOne).not.toHaveBeenCalled();
  });

  it("revokes all update operations after demotion and a new login", async () => {
    await expect(controller.access(actor())).resolves.toEqual({ admin: true });
    findOne.mockResolvedValue({
      ...owner,
      role: UserRole.USER,
      sessionVersion: "2",
    });
    await assertDenied(actor(7, "2"));
  });

  it("rejects a blocked owner", async () => {
    findOne.mockResolvedValue({ ...owner, isActive: false });
    await assertDenied(actor());
  });

  it("rejects a deleted owner", async () => {
    findOne.mockResolvedValue(null);
    await assertDenied(actor());
  });

  it("rejects a stale session", async () => {
    findOne.mockResolvedValue({ ...owner, sessionVersion: "2" });
    await assertDenied(actor());
  });
});

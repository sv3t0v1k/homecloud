import { isNewerVersion, isVersion, parseVersion, withRetry } from "./versions";

describe("parseVersion", () => {
  it("принимает бета-формат канала test", () => {
    expect(parseVersion("v0.9.0-beta.1")).toEqual({ major: 0, minor: 9, patch: 0, beta: 1 });
  });

  it("принимает стабильный семвер", () => {
    expect(parseVersion("v1.0.0")).toEqual({ major: 1, minor: 0, patch: 0, beta: null });
    expect(parseVersion("v1.2.3")).toEqual({ major: 1, minor: 2, patch: 3, beta: null });
  });

  it("отвергает мусор", () => {
    for (const tag of ["", "v1", "v1.2", "1.2.3", "v01.2.3", "v1.2.3-beta.0", "v1.2.3-rc.1", "test-abc1234"]) {
      expect(parseVersion(tag)).toBeNull();
      expect(isVersion(tag)).toBe(false);
    }
  });
});

describe("isNewerVersion", () => {
  it("сравнивает беты по номеру", () => {
    expect(isNewerVersion("v0.9.0-beta.2", "v0.9.0-beta.1")).toBe(true);
    expect(isNewerVersion("v0.9.0-beta.1", "v0.9.0-beta.2")).toBe(false);
    expect(isNewerVersion("v0.9.0-beta.1", "v0.9.0-beta.1")).toBe(false);
  });

  it("стабильная версия новее беты той же X.Y.Z", () => {
    expect(isNewerVersion("v0.9.0", "v0.9.0-beta.5")).toBe(true);
    expect(isNewerVersion("v0.9.0-beta.9", "v0.9.0")).toBe(false);
  });

  it("переход 0.x → 1.0 и выход из беты", () => {
    expect(isNewerVersion("v1.0.0", "v0.10.0-beta.3")).toBe(true);
    expect(isNewerVersion("v1.0.1", "v1.0.0")).toBe(true);
    expect(isNewerVersion("v0.10.0-beta.1", "v1.0.0")).toBe(false);
  });

  it("не сравнивает мусор", () => {
    expect(isNewerVersion("v1.0.0", "мусор")).toBe(false);
    expect(isNewerVersion("мусор", "v1.0.0")).toBe(false);
  });
});

describe("withRetry", () => {
  it("возвращает результат с первой попытки", async () => {
    const task = jest.fn().mockResolvedValue("ok");
    await expect(withRetry(task)).resolves.toBe("ok");
    expect(task).toHaveBeenCalledTimes(1);
  });

  it("повторяет после сбоев и затем возвращает результат", async () => {
    const task = jest.fn().mockRejectedValueOnce(new Error("сеть")).mockResolvedValue("ok");
    await expect(withRetry(task)).resolves.toBe("ok");
    expect(task).toHaveBeenCalledTimes(2);
  });

  it("пробрасывает последнюю ошибку после исчерпания попыток", async () => {
    const failure = new Error("всё сломалось");
    const task = jest.fn().mockRejectedValue(failure);
    await expect(withRetry(task, 3)).rejects.toBe(failure);
    expect(task).toHaveBeenCalledTimes(3);
  });
});

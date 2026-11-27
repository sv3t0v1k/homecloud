import { bootstrap } from "./api-bootstrap";

jest.mock("./uploads/inherited-root-fence", () => ({
  assertInheritedRootFence: jest.fn(),
}));

jest.mock("./api-bootstrap", () => ({
  bootstrap: jest.fn(),
}));

describe("backend bootstrap failure boundary", () => {
  it("reports a fixed failure without leaking the exception or stack", async () => {
    const previousExitCode = process.exitCode;
    const output = jest.spyOn(console, "error").mockImplementation(() => undefined);
    const failure = new Error("postgres://owner:private-password@db/homecloud");
    failure.stack = "private-stack JWT=private-token";
    jest.mocked(bootstrap).mockRejectedValue(failure);

    try {
      await import("./main");
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(bootstrap).toHaveBeenCalledTimes(1);
      expect(process.exitCode).toBe(1);
      expect(output.mock.calls).toEqual([
        ["STOP: backend bootstrap failed"],
      ]);
      expect(JSON.stringify(output.mock.calls)).not.toMatch(
        /private-password|private-stack|private-token/,
      );
    } finally {
      process.exitCode = previousExitCode;
      output.mockRestore();
    }
  });
});

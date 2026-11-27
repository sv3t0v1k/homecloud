import { assertInheritedRootFence } from "./uploads/inherited-root-fence";

async function start(): Promise<void> {
  // Security gate must run before importing AppModule or ConfigModule.
  if (process.platform === "linux") {
    assertInheritedRootFence();
  }

  // Application modules are loaded only after the fence is verified.
  const { bootstrap } = await import("./api-bootstrap");
  await bootstrap();
}

void start().catch(() => {
  // Raw exceptions and stack traces may contain credentials.
  // Detailed safe diagnostics are emitted by StructuredLogger.
  console.error("STOP: backend bootstrap failed");
  process.exitCode = 1;
});

/**
 * Tiny TTY spinner. No-op when the stream isn't a TTY (piped, redirected,
 * non-interactive CI). Use as:
 *
 *   const stop = startSpinner("thinking...", process.stderr);
 *   try { await work; } finally { stop(); }
 *
 * The stop callback erases the spinner line so the next output appears on a
 * clean line.
 */

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function startSpinner(label: string, stream: NodeJS.WritableStream): () => void {
  const isTTY = (stream as NodeJS.WriteStream).isTTY === true;
  if (!isTTY) return () => {};

  let i = 0;
  const writeFrame = () => {
    stream.write(`\r${FRAMES[i % FRAMES.length]} ${label}`);
    i++;
  };
  writeFrame();
  const interval = setInterval(writeFrame, 80);
  // Don't keep the process alive just for the spinner.
  if (typeof (interval as { unref?: () => void }).unref === "function") {
    (interval as { unref: () => void }).unref();
  }
  return () => {
    clearInterval(interval);
    // Erase the spinner line: enough spaces to cover label + spinner + buffer.
    const eraseLen = label.length + 4;
    stream.write("\r" + " ".repeat(eraseLen) + "\r");
  };
}

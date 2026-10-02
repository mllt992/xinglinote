// Observe the rendered result of one real pan gesture. Do not send another
// gesture as a retry: a stalled canvas must remain a failed acceptance step.
export function panMoved(before, after) {
  return !!before && !!after && (Math.abs(after.x - before.x) > 20 || Math.abs(after.y - before.y) > 20);
}

export async function observePan(read, before, {
  timeoutMs = 1600,
  now = Date.now,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  const started = now();
  let previous = null, stable = 0, after = null;
  do {
    after = await read();
    if (panMoved(before, after) && previous && Math.abs(after.x - previous.x) < 1 && Math.abs(after.y - previous.y) < 1) stable++;
    else stable = 0;
    if (stable >= 2) return { moved: true, before, after, elapsedMs: now() - started };
    previous = after;
    await sleep(80);
  } while (now() - started < timeoutMs);
  return { moved: false, before, after, elapsedMs: now() - started };
}

// src/engine/motion-clock.ts — the fixed virtual-time reference for
// character motion.
//
// Movement is authored at a FIXED 60 ticks-per-virtual-second reference:
// the mover walks 2 px and advances one interpolation phase per reference
// tick, so a 16 px tile takes 8 reference ticks (movement.ts), an NPC
// patrol step takes 8, and the in-route waits / random-walk think beats are
// counted in the same ticks.
//
// The host's simulation rate (framework/clock.ts simulationHz) need not be
// 60. A host frame at hz < 60 spans more virtual time, so the motion fold
// runs `MOTION_HZ / hz` reference ticks inside that one host frame instead
// of one guest frame's worth of motion: 2 ticks at 30 Hz, 3 at 20 Hz, 15 at
// 4 Hz. The ordered world trajectory is then a function of virtual time and
// is identical at 60/30/20/4 Hz: movement, NPCs, forced routes, waits,
// typewriter reveal, fades, and interpreter-to-route handoffs all advance
// one reference tick at a time.
//
// The interpreter compiles time-bearing commands against MOTION_HZ and runs
// in that ordered fold. Input edges (confirm/cancel/list edges) are
// host-frame wide, so reference ticks beyond the first reuse the held BTN
// mask and carry no edges.
//
// The default bundle bakes TICKS_PER_SECOND = 60, so every valid host rate
// is a divisor of MOTION_HZ and the scale is an exact integer.

/** Motion reference ticks per virtual second. */
export const MOTION_HZ = 60;

/** Reference motion ticks folded in one host virtual frame at `hz`. Every
 *  supported host rate divides MOTION_HZ exactly; a rate that does not
 *  (a 120 Hz ProMotion bake) throws here at session creation rather than
 *  desyncing motion from the clock. */
export function motionTicksPerFrame(hz: number): number {
  if (!Number.isInteger(hz) || hz <= 0 || MOTION_HZ % hz !== 0) {
    throw new Error(`motion: simulationHz ${hz} must be a positive divisor of ${MOTION_HZ}`);
  }
  return MOTION_HZ / hz;
}

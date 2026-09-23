// src/ui/PlayerSprite.tsx — one Image node for the player character.
//
// The parent owns movement and drives screen position through the same
// compiled jump batch as the world/map layers (one setPropBatch per moved
// frame). This component only chooses the pose IMAGE:
//
//   resting  -> the idle frame of the current facing
//   walking  -> idle / walk-L / walk-R chosen from the mover phase
//
// The image keys come from the caller's PlayerFrames table (its own baked
// asset manifest): the runtime names no asset paths of its own.
//
// The pose is a plain static image keyed off saved reducer state, not a core
// auto-play sprite atlas. An auto-play atlas derives its cell from
// (coreFrame - sprite_start), a host clock the save snapshot cannot carry:
// after a restore (or while the reducer is frozen in the save menu) the
// elapsed counter shifts the cycle, so the same state rendered different
// pixels. A setImage emits only when the chosen key changes, so a steady
// pose within a step costs nothing.

import { Image, type NodeMirror } from "@pocketjs/framework/components";
import type { Facing } from "../engine/types.ts";
import type { WalkPose } from "../engine/movement.ts";

/** Image keys for the 12 walker frames, indexed by facing (0 down, 1 left,
 *  2 up, 3 right). */
export interface PlayerFrames {
  idle: readonly [string, string, string, string];
  walkL: readonly [string, string, string, string];
  walkR: readonly [string, string, string, string];
}

export interface PlayerSpriteProps {
  /** 0 idle stance, 1 left/back step, 2 right/front step (walkPose). */
  pose: WalkPose;
  facing: Facing;
  frames: PlayerFrames;
  ref?: (n: NodeMirror) => void;
}

export function playerImageKey(pose: WalkPose, facing: Facing, frames: PlayerFrames): string {
  if (pose === 1) return frames.walkL[facing]!;
  if (pose === 2) return frames.walkR[facing]!;
  return frames.idle[facing]!;
}

export function PlayerSprite(props: PlayerSpriteProps) {
  return (
    <Image
      class="absolute w-[16] h-[16]"
      src={playerImageKey(props.pose, props.facing, props.frames)}
      style={{ posType: 1, insetL: 0, insetT: 0 }}
      ref={props.ref}
    />
  );
}

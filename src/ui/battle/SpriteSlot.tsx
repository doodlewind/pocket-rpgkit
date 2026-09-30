// src/ui/battle/SpriteSlot.tsx — KB4: one battler image, positioned and
// perturbed entirely from state. Base position, the active SpriteEffect
// descriptor and `nowTick` are all props; this component only calls the
// pure math in effects.ts and paints the result, so it holds no clock and
// two renders of the same props are pixel-identical (the rewind/multi-Hz
// contract every KB4 piece keeps).

import { Image } from "@pocketjs/framework/components";
import { faintPose, flashOpacity, shakeOffsetX, type SpriteEffect } from "./effects.ts";

export interface SpriteSlotProps {
  src: string;
  /** Top-left of the slot at rest, before any effect offset. */
  x: number;
  y: number;
  width: number;
  height: number;
  effect: Readonly<SpriteEffect>;
  nowTick: number;
  /** Mirror horizontally (a "facing" battler drawn from a single sheet). */
  flip?: boolean;
  shakeAmplitude?: number;
  faintSink?: number;
  zIndex?: number;
  debugName?: string;
}

export function SpriteSlot(props: SpriteSlotProps) {
  const dx = () => shakeOffsetX(props.effect, props.nowTick, props.shakeAmplitude);
  const flash = () => flashOpacity(props.effect, props.nowTick);
  const faint = () => faintPose(props.effect, props.nowTick, props.faintSink);
  const opacity = () => flash() * faint().opacity;

  return (
    <Image
      class="absolute"
      src={props.src}
      style={{
        posType: 1,
        insetL: props.x + dx(),
        insetT: props.y + faint().sinkY,
        width: props.width,
        height: props.height,
        opacity: opacity(),
        scaleX: props.flip ? -1 : 1,
        zIndex: props.zIndex ?? 0,
      }}
      debugName={props.debugName}
    />
  );
}

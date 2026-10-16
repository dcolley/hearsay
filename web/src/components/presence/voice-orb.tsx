"use client";

/**
 * VoiceOrb — the presence face (see LEARN: Voice orb).
 *
 * One 96px-ish glowing sphere with two eyes, a mouth while talking, and a
 * mood per agent state. All animation is CSS keyed off custom properties
 * from orb-mood.ts, so the component stays presentational and the whole
 * personality lives in a tested pure module.
 */

import type { CSSProperties } from "react";
import type { AgentState } from "@/lib/perception/protocol";
import { orbLook, orbVars } from "@/lib/perception/orb-mood";

const ORB_CSS = `
.voice-orb {
  position: relative;
  width: var(--orb-size);
  height: var(--orb-size);
  border-radius: 50%;
  background: radial-gradient(circle at 35% 28%, rgba(255,255,255,.45), transparent 42%),
    linear-gradient(160deg, var(--orb-a), var(--orb-b));
  box-shadow: 0 0 calc(var(--orb-glow) * 46px) calc(var(--orb-glow) * 8px) var(--orb-b);
  animation: orb-float var(--orb-pulse) ease-in-out infinite alternate;
  transition: box-shadow 400ms ease, width 300ms ease, height 300ms ease;
}
.voice-orb__eyes {
  position: absolute;
  inset: 22% 12% auto 12%;
  display: flex;
  justify-content: space-between;
}
.voice-orb__eye {
  position: relative;
  width: 24%;
  aspect-ratio: .62;
  border-radius: 50%;
  background: #f8fafc;
  display: flex;
  align-items: center;
  justify-content: center;
  animation: orb-blink var(--orb-blink-period) infinite;
}
.voice-orb__pupil {
  width: 56%;
  aspect-ratio: 1;
  border-radius: 50%;
  background: #0f172a;
}
.voice-orb__mouth {
  position: absolute;
  left: 50%;
  bottom: 20%;
  width: 30%;
  height: 12%;
  transform: translateX(-50%) scaleY(.35);
  border-radius: 50%;
  background: #0f172a;
  opacity: 0;
}
.drift-track .voice-orb__pupil { animation: orb-track calc(var(--orb-pulse) * 2) ease-in-out infinite alternate; }
.drift-sweep .voice-orb__pupil { animation: orb-sweep calc(var(--orb-pulse) * 3) ease-in-out infinite alternate; }

.mood-ponder .voice-orb__eye { transform: scaleY(.5); }
.mood-sleep .voice-orb__eye { transform: scaleY(.16); }
.mood-alert .voice-orb__eye { transform: scaleY(1.08); }
.mood-startled .voice-orb__eye { transform: scaleY(1.2); }
.mood-startled { animation: orb-float var(--orb-pulse) ease-in-out infinite alternate, orb-shake 320ms ease-in-out 1; }

.mood-talk .voice-orb__mouth, .mood-startled .voice-orb__mouth { opacity: 1; }
.mood-talk .voice-orb__mouth { animation: orb-talk calc(var(--orb-pulse) / 3) ease-in-out infinite; }

@keyframes orb-float {
  from { transform: translateY(-2.5%); }
  to { transform: translateY(2.5%); }
}
@keyframes orb-blink {
  0%, 93%, 100% { transform: scaleY(1); }
  96.5% { transform: scaleY(.08); }
}
@keyframes orb-track {
  from { transform: translateX(-22%); }
  to { transform: translateX(22%); }
}
@keyframes orb-sweep {
  from { transform: translate(-26%, 6%); }
  to { transform: translate(26%, -4%); }
}
@keyframes orb-talk {
  0%, 100% { transform: translateX(-50%) scaleY(.3); }
  50% { transform: translateX(-50%) scaleY(1); }
}
@keyframes orb-shake {
  0%, 100% { translate: 0 0; }
  25% { translate: -3.5% 0; }
  75% { translate: 3.5% 0; }
}
@media (prefers-reduced-motion: reduce) {
  .voice-orb, .voice-orb__eye, .voice-orb__mouth, .voice-orb__pupil {
    animation-duration: .01ms !important;
    animation-iteration-count: 1 !important;
  }
}
`;

export function VoiceOrb({
  state,
  running,
}: {
  state: AgentState;
  running: boolean;
}) {
  const look = orbLook(state, running);
  return (
    <div
      className={`voice-orb mood-${look.mood} drift-${look.drift}`}
      style={orbVars(look) as CSSProperties}
      role="img"
      aria-label={`Agent ${look.mood}`}
    >
      <div className="voice-orb__eyes">
        <div className="voice-orb__eye">
          <div className="voice-orb__pupil" />
        </div>
        <div className="voice-orb__eye">
          <div className="voice-orb__pupil" />
        </div>
      </div>
      <div className="voice-orb__mouth" />
      <style>{ORB_CSS}</style>
    </div>
  );
}

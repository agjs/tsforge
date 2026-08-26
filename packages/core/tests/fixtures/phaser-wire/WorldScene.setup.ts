import { createHudFeature } from "@features/hud";
import { createMovementFeature } from "@features/movement";
import { createEventBus } from "@shared/events";
import type * as Phaser from "phaser";

export const setupWorldScene = async () => {
  const events = createEventBus();
  const movement = createMovementFeature({ events });
  const hud = createHudFeature({ events });

  return {
    update(_deltaMs: number) {
      void movement;
    },
    dispose() {
      hud.dispose();
      events.clear();
    },
  };
};

void Phaser;

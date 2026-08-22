import type * as Phaser from "phaser";

export interface IWorldSceneRuntime {
  update: (deltaMs: number) => void;
  dispose: () => void;
}

export function setupWorldScene(scene: Phaser.Scene): IWorldSceneRuntime {
  const sprite = scene.add.rectangle(40, 40, 24, 24, 0x4caf50);

  return {
    update(_deltaMs: number) {
      sprite.x += 1;
    },
    dispose() {
      sprite.destroy();
    },
  };
}

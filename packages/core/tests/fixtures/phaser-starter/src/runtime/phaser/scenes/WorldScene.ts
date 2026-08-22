import * as Phaser from "phaser";

import { WORLD_SCENE_KEY } from "./keys";
import { setupWorldScene, type IWorldSceneRuntime } from "./WorldScene.setup";

export class WorldScene extends Phaser.Scene {
  private runtime: IWorldSceneRuntime | null = null;

  constructor() {
    super(WORLD_SCENE_KEY);
  }

  create(): void {
    this.runtime = setupWorldScene(this);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.runtime?.dispose();
      this.runtime = null;
    });
  }

  override update(_time: number, delta: number): void {
    this.runtime?.update(delta);
  }
}

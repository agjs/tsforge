import { loadRecipes, type ITaskRecipe } from "../config/recipes";
import {
  runOwnedMenu,
  type IMenuRow,
  type IOwnedMenuSelectControl,
} from "../render/owned-menu";

/**
 * In-REPL recipe picker: discovers .tsforge/recipes/*.json files,
 * opens an interactive menu, and runs the selected recipe.
 */

export interface IReplRecipeDeps {
  readonly cwd: string;
  readonly color: boolean;
  readonly suspend: () => void;
  readonly resume: () => void;
  readonly runRecipe: (recipe: ITaskRecipe) => void;
  readonly out: (s: string) => void;
}

/**
 * Map recipes to menu rows with id as label and description (or fallback).
 * describe is never empty — must always have a one-line summary.
 */
export function recipeRows(recipes: readonly ITaskRecipe[]): IMenuRow[] {
  return recipes.map((recipe) => ({
    group: "Recipes",
    label: recipe.id,
    describe: recipe.description ?? "(no description)",
  }));
}

/**
 * Open the recipe picker menu. Loads recipes from .tsforge/recipes/*.json,
 * displays them in an owned menu, and runs the selected recipe.
 * If no recipes are found, outputs a note and returns without opening the menu.
 */
export async function openRecipePicker(deps: IReplRecipeDeps): Promise<void> {
  const recipes = await loadRecipes(deps.cwd);

  if (recipes.length === 0) {
    deps.out("No recipes found. Add .tsforge/recipes/*.json to get started.\n");

    return;
  }

  const rows = (): readonly IMenuRow[] => recipeRows(recipes);

  const onSelect = (index: number, control: IOwnedMenuSelectControl): void => {
    const recipe = recipes[index];

    if (recipe !== undefined) {
      deps.runRecipe(recipe);
      control.close();
    }
  };

  const menuDeps = {
    color: deps.color,
    title: "tsforge recipes",
    subtitle: "Select a recipe to run",
    footer: "↑/↓ move   enter run   esc done",
    suspend: deps.suspend,
    resume: deps.resume,
    rows,
    onSelect,
  };

  await runOwnedMenu(menuDeps);
}

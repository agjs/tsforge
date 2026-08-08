import { loadRecipes, type ITaskRecipe } from "../config/recipes";
import { runInlineMenu, type IMenuRowData } from "../render/inline-menu";

/**
 * In-REPL recipe picker: discovers .tsforge/recipes/*.json files,
 * opens an interactive menu, and runs the selected recipe.
 */

export interface IReplRecipeDeps {
  readonly cwd: string;
  readonly render: (lines: readonly string[]) => void;
  readonly close: () => void;
  readonly runRecipe: (recipe: ITaskRecipe) => void;
  readonly out: (s: string) => void;
  /** Overlay width. Prefer main-pane inner cols when the pane console is live. */
  readonly columns?: number;
}

/**
 * Map recipes to inline menu rows with id as label and description (or fallback).
 * describe is never empty — must always have a one-line summary.
 */
export function recipeRows(recipes: readonly ITaskRecipe[]): IMenuRowData[] {
  return recipes.map((recipe) => ({
    id: recipe.id,
    label: recipe.id,
    describe: recipe.description ?? "(no description)",
  }));
}

/**
 * Open the recipe picker menu. Loads recipes from .tsforge/recipes/*.json,
 * displays them in an inline menu, and runs the selected recipe.
 * If no recipes are found, outputs a note and returns without opening the menu.
 */
export async function openRecipePicker(deps: IReplRecipeDeps): Promise<void> {
  const recipes = await loadRecipes(deps.cwd);

  if (recipes.length === 0) {
    deps.out("No recipes found. Add .tsforge/recipes/*.json to get started.\n");

    return;
  }

  const rows = recipeRows(recipes);

  const selected = await runInlineMenu(rows, {
    title: "recipes",
    render: deps.render,
    close: deps.close,
    columns: deps.columns,
  });

  if (selected !== null) {
    const recipe = recipes[selected];

    if (recipe !== undefined) {
      deps.runRecipe(recipe);
    }
  }
}

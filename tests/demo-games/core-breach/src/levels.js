// Level data lives in a JSON file next to the game, located from this module's URL.
export async function loadLevels() {
  const res = await fetch(new URL('../data/levels.json', import.meta.url));
  if (!res.ok) throw new Error('levels.json: HTTP ' + res.status);
  return res.json();
}

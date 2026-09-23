// The `l` label field's grammar: whitespace/comma separated names; a leading
// `-` removes. Pure, so it is unit tested.

export function parseLabelInput(text: string): { add: string[]; remove: string[] } {
  const add: string[] = [];
  const remove: string[] = [];
  for (const token of text.split(/[\s,]+/u)) {
    if (token === "" || token === "-") continue;
    if (token.startsWith("-")) remove.push(token.slice(1));
    else add.push(token);
  }
  return { add: [...new Set(add)], remove: [...new Set(remove)] };
}

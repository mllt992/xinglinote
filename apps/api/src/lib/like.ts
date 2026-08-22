/** LIKE / ILIKE 里的 % _ \ 当字面量，不当通配符。 */
export function likeContains(query: string) {
  return `%${query.replace(/[\\%_]/g, "\\$&")}%`;
}

/** The repository front page is also the npm front page, without contributor-only sections. */
export function npmReadme(source: string): string {
  const start = "<!-- contributor-only:start -->",
    end = "<!-- contributor-only:end -->";
  if (
    source.split(start).length !== 2 ||
    source.split(end).length !== 2 ||
    source.indexOf(end) < source.indexOf(start)
  )
    throw new Error(
      "TC_README_TEMPLATE: README requires one ordered contributor-only section.",
    );
  return source
    .slice(0, source.indexOf(start))
    .concat(source.slice(source.indexOf(end) + end.length))
    .replace(
      /src="docs\/assets\/([^"<>]+)"/g,
      'src="https://raw.githubusercontent.com/danchar12138/pelican-engine/main/docs/assets/$1"',
    )
    .replace(/\n{3,}/g, "\n\n");
}

/**
 * Load ESM-only packages from a CommonJS-built VS Code extension.
 * TypeScript rewrites `import("pkg")` to `require("pkg")` under "module": "commonjs",
 * which fails for packages that only expose "import" in their exports map.
 */
export function esmImport<T>(specifier: string): Promise<T> {
  const dynamicImport = new Function('specifier', 'return import(specifier)') as (
    specifier: string,
  ) => Promise<T>;
  return dynamicImport(specifier);
}

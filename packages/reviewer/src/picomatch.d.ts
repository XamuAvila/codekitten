/**
 * Minimal type declaration for picomatch v4.
 * picomatch v4 does not ship types; this covers only the usage in this package.
 */
declare module "picomatch" {
  interface PicomatchOptions {
    readonly dot?: boolean;
  }

  type Matcher = (input: string) => boolean;

  function picomatch(
    patterns: string | readonly string[],
    options?: PicomatchOptions,
  ): Matcher;

  export default picomatch;
}

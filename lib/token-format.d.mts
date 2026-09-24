export interface TokenFormatOptions {
  precision: "compact" | "detailed";
  /** Context labels omit the redundant .0 on k, but retain it on M. */
  trimKZero?: boolean;
}
export function formatTokenCount(value: number | null | undefined, options: TokenFormatOptions): string;

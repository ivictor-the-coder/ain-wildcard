export type Options = Record<string, string | true>;

export declare function parseArgs(
  argv: string[],
  opts?: { booleans?: string[] },
): { options: Options; positional: string[] };

export declare function bool(options: Options, name: string): boolean;

export declare function text(options: Options, name: string, fallback: string): string;
export declare function text(options: Options, name: string, fallback?: undefined): string | undefined;

export declare function int(options: Options, name: string, fallback: number): number;
export declare function int(options: Options, name: string, fallback?: undefined): number | undefined;

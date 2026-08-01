import type { Options, ParsedArgs } from "./args.js";
import type { HttpClient } from "./http.js";
import type { Output } from "./output.js";

/** Everything a command needs: parsed input, output router, and API client. */
export type Ctx = {
  args: ParsedArgs;
  positionals: string[];
  options: Options;
  out: Output;
  http: HttpClient;
};

export type CommandHandler = (ctx: Ctx) => Promise<void>;

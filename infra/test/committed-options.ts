import * as fs from "fs";
import * as yaml from "js-yaml";
import * as path from "path";

const ebextensionsDir = path.resolve(__dirname, "../../.ebextensions");

/** Every option set by the committed `.ebextensions` config, as strings. */
export function committedOptions(): Record<string, Record<string, string>> {
  const options: Record<string, Record<string, string>> = {};
  for (const file of fs.readdirSync(ebextensionsDir).sort()) {
    expect(file).toMatch(/\.config$/);
    const config = yaml.load(
      fs.readFileSync(path.join(ebextensionsDir, file), "utf8"),
    ) as Record<string, unknown>;
    // Option settings only: no resources, commands or files.
    expect(Object.keys(config)).toEqual(["option_settings"]);
    const settings = config.option_settings as Record<
      string,
      Record<string, unknown>
    >;
    for (const [namespace, namespaceOptions] of Object.entries(settings)) {
      for (const [name, value] of Object.entries(namespaceOptions)) {
        expect(options[namespace]?.[name]).toBeUndefined();
        (options[namespace] ??= {})[name] = String(value);
      }
    }
  }
  return options;
}

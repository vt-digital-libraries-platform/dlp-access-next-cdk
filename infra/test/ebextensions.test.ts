import * as fs from "fs";
import * as yaml from "js-yaml";
import * as path from "path";

const ebextensions = path.resolve(__dirname, "../../.ebextensions");

/** Every option set by the committed `.ebextensions` config, as strings. */
function committedOptions(): Record<string, Record<string, string>> {
  const options: Record<string, Record<string, string>> = {};
  for (const file of fs.readdirSync(ebextensions).sort()) {
    expect(file).toMatch(/\.config$/);
    const config = yaml.load(
      fs.readFileSync(path.join(ebextensions, file), "utf8"),
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

describe(".ebextensions", () => {
  test("sets exactly the settings every frontend shares", () => {
    expect(committedOptions()).toEqual({
      "aws:elasticbeanstalk:environment": {
        EnvironmentType: "LoadBalanced",
        LoadBalancerType: "application",
      },
      "aws:autoscaling:asg": { MinSize: "1", MaxSize: "1" },
      "aws:elbv2:listener:443": {
        Protocol: "HTTPS",
        SSLPolicy: "ELBSecurityPolicy-TLS13-1-2-2021-06",
      },
      "aws:autoscaling:launchconfiguration": { DisableIMDSv1: "true" },
      "aws:elasticbeanstalk:healthreporting:system": { SystemType: "enhanced" },
      "aws:elasticbeanstalk:managedactions": {
        ManagedActionsEnabled: "true",
        PreferredStartTime: "Sun:09:00",
      },
      "aws:elasticbeanstalk:managedactions:platformupdate": {
        UpdateLevel: "minor",
      },
      "aws:elasticbeanstalk:cloudwatch:logs": {
        StreamLogs: "true",
        RetentionInDays: "7",
      },
    });
  });
});

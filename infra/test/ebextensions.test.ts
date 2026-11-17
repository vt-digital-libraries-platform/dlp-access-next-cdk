import { committedOptions } from "./committed-options";

describe(".ebextensions", () => {
  test("sets exactly the settings every frontend shares", () => {
    expect(committedOptions()).toEqual({
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

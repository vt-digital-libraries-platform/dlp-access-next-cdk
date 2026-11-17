import { awsJson, CommandRunner } from "../command-runner";
import { FRONTEND_APPLICATION } from "../config/web";
import {
  BACKEND_ENV_TAG,
  BRANCH_TAG,
  describeEnvironment,
  readTags,
} from "./environment";
import { FrontendNames } from "./frontend";

const APP_ENVIRONMENT = "aws:elasticbeanstalk:application:environment";

/** What a developer needs to reach a frontend, or run its branch locally. */
export interface FrontendStatus {
  readonly branch: string;
  readonly appUrl: string;
  /** The Beanstalk endpoint the branch's CNAME points at. */
  readonly endpoint: string;
  readonly status: string;
  readonly health: string;
  readonly versionLabel?: string;
  /** The backend env the frontend was created for, from its tag. */
  readonly backendEnv?: string;
  readonly cognitoIssuer?: string;
  readonly cognitoClientId?: string;
  readonly cognitoIdentityProvider?: string;
  /** The name of the secret holding the client secret, never its value. */
  readonly secretName: string;
}

/**
 * The branch's frontend as it is deployed, or undefined when it has none.
 * Reads only the environment, its tags and its option settings: never the
 * secret or the Cognito client, so the client secret can't be printed.
 */
export function readFrontendStatus(
  names: FrontendNames,
  run: CommandRunner,
): FrontendStatus | undefined {
  const environment = describeEnvironment(names, run);
  if (!environment) {
    return undefined;
  }
  const tags = readTags(environment, run);
  const [configuration] = awsJson(run, [
    "elasticbeanstalk",
    "describe-configuration-settings",
    "--application-name",
    FRONTEND_APPLICATION,
    "--environment-name",
    names.environmentName,
  ]).ConfigurationSettings as {
    OptionSettings: { Namespace: string; OptionName: string; Value?: string }[];
  }[];
  const variable = (name: string) =>
    configuration?.OptionSettings.find(
      ({ Namespace, OptionName }) =>
        Namespace === APP_ENVIRONMENT && OptionName === name,
    )?.Value;
  return {
    branch: tags.get(BRANCH_TAG) ?? names.branch,
    appUrl: names.appUrl,
    endpoint: environment.CNAME,
    status: environment.Status,
    health: environment.Health,
    versionLabel: environment.VersionLabel,
    backendEnv: tags.get(BACKEND_ENV_TAG),
    cognitoIssuer: variable("COGNITO_ISSUER"),
    cognitoClientId: variable("COGNITO_CLIENT_ID"),
    cognitoIdentityProvider: variable("COGNITO_IDENTITY_PROVIDER"),
    secretName: names.secretName,
  };
}

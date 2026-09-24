import { App } from 'aws-cdk-lib';
import { ApiStack } from './api-stack';
import { DataStack } from './data-stack';
import { resolveEnvironment } from './environments';

/** Adds one environment's Data and Api stacks to the app. */
export function buildApp(app: App, envName: string | undefined): { data: DataStack; api: ApiStack } {
  const config = resolveEnvironment(envName);
  const env = { account: config.account, region: config.region };
  const prefix = `DlpAccessNext-${config.name}`;

  const data = new DataStack(app, `${prefix}-Data`, { env, config });
  const api = new ApiStack(app, `${prefix}-Api`, {
    env,
    config,
    tables: data.tables,
    searchDomain: data.searchDomain,
  });
  return { data, api };
}

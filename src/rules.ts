import {
  type Activation,
  overrideOrigin,
  type Profile,
  type ProfileDocument,
  pageDomainHost,
} from './model';

const escapeRegex = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function urlRegex(value: string, pathPrefix: string): string {
  const url = new URL(value);
  const defaultPort = url.protocol === 'https:' ? '443' : '80';
  return `^${escapeRegex(url.protocol)}//${escapeRegex(url.hostname)}${url.port ? `:${url.port}` : `(?::${defaultPort})?`}${escapeRegex(pathPrefix)}`;
}
export function compileRules(
  doc: ProfileDocument,
  activations: Activation[],
): chrome.declarativeNetRequest.Rule[] {
  const output: chrome.declarativeNetRequest.Rule[] = [];
  const add = (
    action: chrome.declarativeNetRequest.RuleAction,
    regexFilter: string,
    profile: Profile,
    tabId: number,
    topDomain?: string,
  ) => {
    output.push({
      id: output.length + 1,
      priority: 1,
      action,
      condition: {
        tabIds: [tabId],
        regexFilter,
        isUrlFilterCaseSensitive: true,
        resourceTypes: ['main_frame'],
      },
    });
    output.push({
      id: output.length + 1,
      priority: 1,
      action,
      condition: {
        tabIds: [tabId],
        regexFilter,
        isUrlFilterCaseSensitive: true,
        excludedResourceTypes: ['main_frame'],
        topDomains: topDomain
          ? [topDomain]
          : profile.scope.pageDomains.map(pageDomainHost),
        initiatorDomains: profile.scope.pageDomains.map(pageDomainHost),
      },
    });
  };
  for (const activation of activations) {
    const profile = doc.profiles.find(
      (profile) => profile.id === activation.profileId,
    );
    if (!profile) throw new Error('Active profile no longer exists.');
    for (const rule of profile.rules) {
      const targetOrigin = overrideOrigin(rule, activation.pageOrigin);
      if (targetOrigin) {
        const target = new URL(targetOrigin);
        add(
          {
            type: 'redirect',
            redirect: {
              transform: {
                scheme: target.protocol.slice(0, -1),
                host: target.hostname,
                port: target.port,
              },
            },
          },
          urlRegex(rule.match.origin, rule.match.pathPrefix),
          profile,
          activation.tabId,
          rule.redirectPageDomain ? target.hostname : undefined,
        );
      }
      if (rule.requestHeaders.length) {
        const action: chrome.declarativeNetRequest.RuleAction = {
          type: 'modifyHeaders',
          requestHeaders: rule.requestHeaders.map((header) => ({
            header: header.name,
            operation: header.operation,
            ...(header.operation === 'set' ? { value: header.value } : {}),
          })),
        };
        for (const value of [
          rule.match.origin,
          ...(targetOrigin ? [targetOrigin] : []),
        ])
          add(
            action,
            urlRegex(value, rule.match.pathPrefix),
            profile,
            activation.tabId,
            rule.redirectPageDomain && value === targetOrigin
              ? new URL(value).hostname
              : undefined,
          );
      }
    }
  }
  if (output.length > 1000)
    throw new Error(
      'Too many active rules. Disable a profile in another tab first.',
    );
  return output;
}

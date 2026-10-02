import { z } from 'zod';

export function origin(value: string): string {
  const url = new URL(value);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error(
      'Enter an HTTP(S) origin without a path, credentials, query, or fragment.',
    );
  return url.origin;
}
const nonempty = z.string().trim().min(1, 'This field is required.');
const originSchema = nonempty.transform((value, ctx) => {
  try {
    return origin(value);
  } catch {
    ctx.addIssue({
      code: 'custom',
      message:
        'Enter an HTTP(S) origin without a path, credentials, query, or fragment.',
    });
    return z.NEVER;
  }
});
export function normalizePageDomain(value: string): string {
  if (/[\s\\]/.test(value)) throw new Error('Invalid page domain.');
  const authority = value
    .replace(/^[a-z]+:\/\//i, '')
    .split(/[/?#]/)[0]
    .toLowerCase();
  const wildcard = authority.startsWith('*.');
  const input = value.includes('://') ? value : `https://${value}`;
  // Chrome encodes '*' in URL hostnames; parse the host independently of the wildcard.
  const url = new URL(
    wildcard ? input.replace(/^([a-z]+:\/\/)\*\./i, '$1') : input,
  );
  if ((wildcard ? authority.slice(2) : authority) !== url.hostname)
    throw new Error(
      'Use a hostname without a port or credentials (punycode for international domains).',
    );
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.port ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error(
      'Use a hostname or an HTTP(S) host pattern without a port or path.',
    );
  const host = url.hostname;
  if (
    !host ||
    host.includes('*') ||
    (!/^\[[0-9a-f:]+\]$/.test(host) &&
      !host
        .split('.')
        .every((label) => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)))
  )
    throw new Error(
      'Use a hostname or a leading *. wildcard, such as *.preview.example.com.',
    );
  if (wildcard && (/^[0-9.]+$/.test(host) || host.startsWith('[')))
    throw new Error('Wildcards require a domain, not an IP address.');
  return `${wildcard ? '*.' : ''}${host}`;
}
export const pageDomainHost = (value: string) =>
  normalizePageDomain(value).replace(/^\*\./, '');
const pageDomainSchema = nonempty.transform((value, ctx) => {
  try {
    return normalizePageDomain(value);
  } catch (error) {
    ctx.addIssue({
      code: 'custom',
      message: error instanceof Error ? error.message : 'Invalid page domain.',
    });
    return z.NEVER;
  }
});
// Current-page override patterns may also contain one wildcard in the first label.
export function normalizeOverrideDomain(value: string): string {
  const authority = value
    .replace(/^[a-z]+:\/\//i, '')
    .split(/[/?#]/)[0]
    .toLowerCase();
  if (!authority.includes('*') || authority.startsWith('*.'))
    return normalizePageDomain(value);
  const [label, ...suffix] = authority.split('.');
  if (
    (label.match(/\*/g) ?? []).length !== 1 ||
    suffix.length < 2 ||
    suffix.some((part) => part.includes('*'))
  )
    throw new Error(
      'Use one wildcard in the first hostname label, such as www-example-com-*.preview.example.com.',
    );
  // Validate URL shape and DNS labels using a literal stand-in for the wildcard.
  normalizePageDomain(value.replace('*', 'wildcard'));
  const domain = suffix.join('.');
  if (/^[0-9.]+$/.test(domain))
    throw new Error('Wildcards require a domain, not an IP address.');
  return authority;
}
function partialOverride(value: string): boolean {
  return value.includes('*') && !value.startsWith('*.');
}
export function overrideScopeDomain(value: string): string {
  const pattern = normalizeOverrideDomain(value);
  return partialOverride(pattern)
    ? `*.${pattern.split('.').slice(1).join('.')}`
    : pattern;
}
function overrideHostMatches(pattern: string, host: string): boolean {
  if (!partialOverride(pattern))
    return domainIncludes(pageDomainHost(pattern), host);
  const expression = pattern
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^.]*');
  return new RegExp(`^${expression}$`).test(host);
}
const overrideDomainSchema = nonempty.transform((value, ctx) => {
  try {
    return normalizeOverrideDomain(value);
  } catch (error) {
    ctx.addIssue({
      code: 'custom',
      message:
        error instanceof Error
          ? error.message
          : 'Invalid override domain pattern.',
    });
    return z.NEVER;
  }
});
const headerNameSchema = nonempty
  .regex(/^[!#$%&'*+.^_`|~0-9a-z-]+$/i, 'Invalid header name.')
  .refine(
    (name) =>
      ![
        'host',
        'content-length',
        'connection',
        'transfer-encoding',
        'upgrade',
      ].includes(name.toLowerCase()),
    'Transport headers cannot be edited here. Use host override to change the destination.',
  );
const pathPrefixSchema = nonempty
  .regex(/^\//, 'Path prefix must start with /.')
  .superRefine((value, ctx) => {
    let normalized = false;
    try {
      normalized = new URL(value, 'https://example.test').pathname === value;
    } catch {
      /* Invalid path. */
    }
    if (/[?#\s\\]/.test(value) || /[^\x21-\x7e]/.test(value) || !normalized)
      ctx.addIssue({
        code: 'custom',
        message:
          'Use a normalized, URL-encoded path without a query, fragment, whitespace, backslash, or dot segments.',
      });
  });
export const HeaderChangeSchema = z.discriminatedUnion('operation', [
  z.strictObject({
    operation: z.literal('set'),
    name: headerNameSchema,
    value: z
      .string()
      .refine(
        (value) => !/[\r\n\0]/.test(value),
        'Header values cannot contain line breaks or null bytes.',
      ),
  }),
  z.strictObject({ operation: z.literal('remove'), name: headerNameSchema }),
]);
export const RequestRuleSchema = z
  .strictObject({
    id: nonempty,
    match: z.strictObject({
      origin: originSchema,
      pathPrefix: pathPrefixSchema,
    }),
    redirectOrigin: originSchema.optional(),
    redirectPageDomain: overrideDomainSchema.optional(),
    requestHeaders: z.array(HeaderChangeSchema).max(100),
  })
  .superRefine((rule, ctx) => {
    if (rule.redirectOrigin === rule.match.origin)
      ctx.addIssue({
        code: 'custom',
        path: ['redirectOrigin'],
        message: 'Redirect source and target must differ.',
      });
    if (rule.redirectOrigin && rule.redirectPageDomain)
      ctx.addIssue({
        code: 'custom',
        message:
          'Choose a fixed host override or a current-page domain pattern.',
      });
    if (
      rule.redirectPageDomain &&
      overrideHostMatches(
        rule.redirectPageDomain,
        new URL(rule.match.origin).hostname,
      )
    )
      ctx.addIssue({
        code: 'custom',
        path: ['redirectPageDomain'],
        message:
          'The current-page domain pattern must exclude the request hostname.',
      });
    if (
      !rule.redirectOrigin &&
      !rule.redirectPageDomain &&
      !rule.requestHeaders.length
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Each rule needs a host override or a header change.',
      });
    const names = rule.requestHeaders.map((header) =>
      header.name.toLowerCase(),
    );
    if (new Set(names).size !== names.length)
      ctx.addIssue({
        code: 'custom',
        path: ['requestHeaders'],
        message: 'Duplicate header names within a rule.',
      });
  });
export const ProfileSchema = z
  .strictObject({
    id: nonempty,
    name: nonempty.max(100),
    scope: z.strictObject({
      pageDomains: z
        .array(pageDomainSchema)
        .min(1, 'Add an allowed page domain.')
        .max(100),
    }),
    autoActivateDomain: overrideDomainSchema.optional(),
    rules: z.array(RequestRuleSchema).min(1, 'Add at least one rule.').max(50),
  })
  .superRefine((profile, ctx) => {
    const issue = (message: string) =>
      ctx.addIssue({ code: 'custom', message });
    if (
      new Set(profile.scope.pageDomains.map(pageDomainHost)).size !==
      profile.scope.pageDomains.length
    )
      issue('Duplicate page domains.');
    if (
      new Set(profile.rules.map((rule) => rule.id)).size !==
      profile.rules.length
    )
      issue('Duplicate rule IDs.');
    const ranges = profile.rules.flatMap((rule) =>
      [rule.match.origin, ...(rule.redirectOrigin ? [rule.redirectOrigin] : [])]
        .map((value) => ({
          rule,
          origin: value,
          domain: undefined as string | undefined,
        }))
        .concat(
          rule.redirectPageDomain
            ? [
                {
                  rule,
                  origin: '',
                  domain: rule.redirectPageDomain,
                },
              ]
            : [],
        ),
    );
    for (let i = 0; i < ranges.length; i++)
      for (let j = i + 1; j < ranges.length; j++) {
        const a = ranges[i],
          b = ranges[j];
        if (
          a.rule !== b.rule &&
          (a.domain && b.domain
            ? overrideDomainsOverlap(a.domain, b.domain)
            : a.domain
              ? overrideHostMatches(a.domain, new URL(b.origin).hostname)
              : b.domain
                ? overrideHostMatches(b.domain, new URL(a.origin).hostname)
                : a.origin === b.origin) &&
          (a.rule.match.pathPrefix.startsWith(b.rule.match.pathPrefix) ||
            b.rule.match.pathPrefix.startsWith(a.rule.match.pathPrefix))
        )
          issue(
            'Rules overlap at a source or redirect destination. Combine their headers or use distinct paths.',
          );
      }
    if (
      profile.autoActivateDomain &&
      !pageAllowed(
        profile,
        `https://${pageDomainHost(overrideScopeDomain(profile.autoActivateDomain))}`,
      )
    )
      issue(
        'Allowed page domains must include the automatic activation domain pattern.',
      );
    for (const rule of profile.rules) {
      if (
        rule.redirectPageDomain &&
        !pageAllowed(
          profile,
          `https://${pageDomainHost(overrideScopeDomain(rule.redirectPageDomain))}`,
        )
      )
        issue(
          'Allowed page domains must include the current-page override domain pattern.',
        );
      for (const value of [
        rule.match.origin,
        ...(rule.redirectOrigin ? [rule.redirectOrigin] : []),
      ])
        if (!pageAllowed(profile, value))
          issue(
            'Allowed page domains must include each request and redirect hostname.',
          );
    }
  });
export const ProfileDocumentSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    profiles: z.array(ProfileSchema).max(100),
  })
  .superRefine((doc, ctx) => {
    if (
      new Set(doc.profiles.map((profile) => profile.id)).size !==
      doc.profiles.length
    )
      ctx.addIssue({ code: 'custom', message: 'Duplicate profile IDs.' });
    for (let i = 0; i < doc.profiles.length; i++)
      for (let j = i + 1; j < doc.profiles.length; j++) {
        const a = doc.profiles[i],
          b = doc.profiles[j];
        if (
          a.autoActivateDomain &&
          b.autoActivateDomain &&
          overrideDomainsOverlap(a.autoActivateDomain, b.autoActivateDomain)
        )
          ctx.addIssue({
            code: 'custom',
            path: ['profiles', j, 'autoActivateDomain'],
            message:
              'Automatic activation patterns overlap. Only one profile may automatically activate on a site.',
          });
      }
  });
export type HeaderChange = z.infer<typeof HeaderChangeSchema>;
export type RequestRule = z.infer<typeof RequestRuleSchema>;
export type Profile = z.infer<typeof ProfileSchema>;
export type ProfileDocument = z.infer<typeof ProfileDocumentSchema>;
export interface Activation {
  tabId: number;
  profileId: string;
  pageOrigin?: string;
  automatic?: boolean;
}
export const EMPTY_DOCUMENT: ProfileDocument = {
  schemaVersion: 1,
  profiles: [],
};
export function validateDocument(input: unknown): ProfileDocument {
  const result = ProfileDocumentSchema.safeParse(input);
  if (!result.success)
    throw new Error(
      result.error.issues
        .map(
          (issue) => `${issue.path.join('.') || 'Profiles'}: ${issue.message}`,
        )
        .join('\n'),
    );
  return result.data;
}
function domainIncludes(domain: string, host: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}
function overrideDomainsOverlap(a: string, b: string): boolean {
  if (partialOverride(a) && partialOverride(b)) {
    const [labelA, ...suffixA] = a.split('.');
    const [labelB, ...suffixB] = b.split('.');
    if (suffixA.join('.') !== suffixB.join('.')) return false;
    const [prefixA, endA] = labelA.split('*');
    const [prefixB, endB] = labelB.split('*');
    return (
      (prefixA.startsWith(prefixB) || prefixB.startsWith(prefixA)) &&
      (endA.endsWith(endB) || endB.endsWith(endA))
    );
  }
  if (partialOverride(a)) return partialAndDomainOverlap(a, pageDomainHost(b));
  if (partialOverride(b)) return partialAndDomainOverlap(b, pageDomainHost(a));
  const hostA = pageDomainHost(a),
    hostB = pageDomainHost(b);
  return domainIncludes(hostA, hostB) || domainIncludes(hostB, hostA);
}
function partialAndDomainOverlap(pattern: string, domain: string): boolean {
  const suffix = pattern.split('.').slice(1).join('.');
  return domainIncludes(domain, suffix) || overrideHostMatches(pattern, domain);
}
export function overrideOrigin(
  rule: RequestRule,
  pageOrigin?: string,
): string | undefined {
  if (rule.redirectOrigin) return rule.redirectOrigin;
  if (!rule.redirectPageDomain || !pageOrigin) return undefined;
  const value = origin(pageOrigin);
  return overrideHostMatches(rule.redirectPageDomain, new URL(value).hostname)
    ? value
    : undefined;
}
export function automaticProfile(
  doc: ProfileDocument,
  value: string,
): Profile | undefined {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return undefined;
    return doc.profiles.find(
      (profile) =>
        profile.autoActivateDomain &&
        overrideHostMatches(profile.autoActivateDomain, url.hostname) &&
        pageAllowed(profile, value),
    );
  } catch {
    return undefined;
  }
}
export function pageAllowed(
  profile: { scope: { pageDomains: string[] } },
  value: string,
): boolean {
  try {
    const url = new URL(value);
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      profile.scope.pageDomains.some((pattern) => {
        const domain = pageDomainHost(pattern);
        return url.hostname === domain || url.hostname.endsWith(`.${domain}`);
      })
    );
  } catch {
    return false;
  }
}
export function requiredPermissions(profile: Profile): string[] {
  return [
    ...new Set([
      ...profile.scope.pageDomains.flatMap((pattern) =>
        ['http', 'https'].map((scheme) => {
          const domain = pageDomainHost(pattern);
          return `${scheme}://${domain.startsWith('[') || /^[0-9.]+$/.test(domain) ? domain : `*.${domain}`}/*`;
        }),
      ),
      ...profile.rules
        .flatMap((rule) => [
          rule.match.origin,
          ...(rule.redirectOrigin ? [rule.redirectOrigin] : []),
        ])
        .map((value) => {
          const url = new URL(value);
          // Host permissions cannot constrain ports; native rule conditions do.
          return `${url.protocol}//${url.hostname}/*`;
        }),
    ]),
  ];
}
export function newProfile(): Profile {
  return {
    id: crypto.randomUUID(),
    name: 'New profile',
    scope: { pageDomains: [] },
    rules: [newRule()],
  };
}
export function newRule(): RequestRule {
  return {
    id: crypto.randomUUID(),
    match: { origin: '', pathPrefix: '/' },
    requestHeaders: [],
  };
}

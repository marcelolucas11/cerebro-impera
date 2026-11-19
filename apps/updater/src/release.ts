/*
 * Which releases the updater considers, and what a release must say about
 * itself. A release is only a candidate; nothing in it is trusted until its
 * signature holds (verify.ts).
 */

export type Version = readonly [number, number, number];

/** "1.2.3" or "v1.2.3"; nothing else counts as a release version. */
export function parseVersion(raw: string): Version | null {
  const match = /^v?(\d{1,4})\.(\d{1,4})\.(\d{1,4})$/.exec(raw);
  if (match === null) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function compare(a: Version, b: Version): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

export const versionText = (version: Version): string => version.join('.');

export interface ReleaseAsset {
  name: string;
  url: string;
}

export interface Release {
  tag: string;
  version: Version;
  publishedAt: string;
  notes: string;
  assets: ReleaseAsset[];
}

/** As the GitHub API lists them; only the fields read here. */
export interface GithubRelease {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  published_at: string | null;
  body: string | null;
  assets: { name: string; browser_download_url: string }[];
}

const NOTES_LIMIT = 20_000;

/** The highest published, stable release above the version in use; null when there is none. */
export function newest(listed: readonly GithubRelease[], current: Version): Release | null {
  let best: Release | null = null;
  for (const release of listed) {
    if (release.draft || release.prerelease || release.published_at === null) continue;
    const version = parseVersion(release.tag_name);
    if (version === null || compare(version, current) <= 0) continue;
    if (best !== null && compare(version, best.version) <= 0) continue;
    best = {
      tag: release.tag_name,
      version,
      publishedAt: release.published_at,
      notes: (release.body ?? '').slice(0, NOTES_LIMIT),
      assets: release.assets.map((asset) => ({
        name: asset.name,
        url: asset.browser_download_url,
      })),
    };
  }
  return best;
}

export const MANIFEST = 'cerebro-release.json';
export const MANIFEST_BUNDLE = 'cerebro-release.json.sigstore.json';

/** What the release flow writes about a version, and signs. */
export interface Manifest {
  version: string;
  /** ghcr.io/<owner>/<repo>/api, lower case. */
  image: string;
  digest: string;
  /** The oldest version an installation may update from to this one. */
  minFrom: string;
}

/**
 * Reads a manifest and holds it to the release it came with and to the
 * repository this installation follows. Anything off is refused.
 */
export function readManifest(raw: string, release: Release, repository: string): Manifest | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const manifest = value as Partial<Record<keyof Manifest, unknown>>;
  const { version, image, digest, minFrom } = manifest;
  if (
    typeof version !== 'string' ||
    typeof image !== 'string' ||
    typeof digest !== 'string' ||
    typeof minFrom !== 'string'
  ) {
    return null;
  }
  const said = parseVersion(version);
  if (said === null || compare(said, release.version) !== 0) return null;
  if (image !== `ghcr.io/${repository.toLowerCase()}/api`) return null;
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) return null;
  if (parseVersion(minFrom) === null) return null;
  return { version: versionText(said), image, digest, minFrom };
}

/** The identity the release flow signs with, as Sigstore records it. */
export function signerIdentity(repository: string, tag: string): string {
  return `https://github.com/${repository}/.github/workflows/release.yml@refs/tags/${tag}`;
}

export const SIGNER_ISSUER = 'https://token.actions.githubusercontent.com';

/**
 * Everything a signature must say about where it was made: the release flow of
 * this repository, run because a release was published for this tag, from this
 * very commit. The commit is one the updater has already seen on the default
 * branch, so the flow that signed is the reviewed one, with its approval step:
 * a changed flow pushed under a new tag signs with another commit and is refused.
 */
export interface Signer {
  identity: string;
  issuer: string;
  trigger: 'release';
  ref: string;
  sha: string;
  repository: string;
}

export function signer(repository: string, tag: string, sha: string): Signer {
  return {
    identity: signerIdentity(repository, tag),
    issuer: SIGNER_ISSUER,
    trigger: 'release',
    ref: `refs/tags/${tag}`,
    sha,
    repository,
  };
}

/** The cosign flags that hold a signature to a signer. */
export function signerFlags(who: Signer): string[] {
  return [
    '--certificate-identity',
    who.identity,
    '--certificate-oidc-issuer',
    who.issuer,
    '--certificate-github-workflow-trigger',
    who.trigger,
    '--certificate-github-workflow-ref',
    who.ref,
    '--certificate-github-workflow-sha',
    who.sha,
    '--certificate-github-workflow-repository',
    who.repository,
  ];
}

/** A full commit id, as GitHub writes it. */
export function validCommit(raw: string | null): raw is string {
  return raw !== null && /^[0-9a-f]{40}$/.test(raw);
}

/** "owner/repo", as GitHub spells them. */
export function validRepository(raw: string): boolean {
  return /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(raw);
}

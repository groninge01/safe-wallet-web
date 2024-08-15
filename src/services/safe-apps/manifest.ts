import type { AllowedFeatures, SafeAppDataWithPermissions } from '@/components/safe-apps/types'
import { isRelativeUrl, trimTrailingSlash } from '@/utils/url'
import { SafeAppAccessPolicyTypes } from '@safe-global/safe-gateway-typescript-sdk'
import * as cheerio from 'cheerio'

async function fetchAndParse(url: string) {
  try {
    const response = await fetch(url)

    if (!response.ok) {
      throw new Error(`Response status: ${response.status}`)
    }

    const html = await response.text()
    const $ = cheerio.load(html)
    const manifestPath = $('link[rel=manifest]').attr('href')

    return manifestPath
  } catch (error) {
    console.error(error)
  }
}

type AppManifestIcon = {
  src: string
  sizes: string
  type?: string
  purpose?: string
}

export type AppManifest = {
  // SPEC: https://developer.mozilla.org/en-US/docs/Web/Manifest
  name: string
  short_name?: string
  description: string
  icons?: AppManifestIcon[]
  iconPath?: string
  safe_apps_permissions?: AllowedFeatures[]
}

const MIN_ICON_WIDTH = 128

const chooseBestIcon = (icons: AppManifestIcon[]): string => {
  const svgIcon = icons.find((icon) => icon?.sizes?.includes('any') || icon?.type === 'image/svg+xml')

  if (svgIcon) {
    return svgIcon.src
  }

  for (const icon of icons) {
    for (const size of icon.sizes.split(' ')) {
      if (Number(size.split('x')[0]) >= MIN_ICON_WIDTH) {
        return icon.src
      }
    }
  }

  return icons[0].src || ''
}

// The icons URL can be any of the following format:
// - https://example.com/icon.png
// - icon.png
// - /icon.png
// This function calculates the absolute URL of the icon taking into account the
// different formats.
const getAppLogoUrl = (appUrl: string, { icons = [], iconPath = '' }: AppManifest) => {
  const iconUrl = icons.length ? chooseBestIcon(icons) : iconPath
  const includesBaseUrl = iconUrl.startsWith('https://')
  const baseUrl = new URL(appUrl).origin

  if (includesBaseUrl) {
    return iconUrl
  }

  return `${baseUrl}${isRelativeUrl(iconUrl) ? '' : '/'}${iconUrl}`
}

const fetchAppManifest = async (appUrl: string, timeout = 5000): Promise<unknown> => {
  const normalizedUrl = trimTrailingSlash(appUrl)
  let manifestUrl = `${normalizedUrl}/manifest.json`

  const manifestPath = await fetchAndParse(normalizedUrl)

  if (manifestPath) {
    const url = new URL(appUrl)
    manifestUrl = `${url.origin}${manifestPath}`
  }

  // A lot of apps are hosted on IPFS and IPFS never times out, so we add our own timeout
  const controller = new AbortController()
  const id = setTimeout(() => controller.abort(), timeout)

  const response = await fetch(manifestUrl, {
    signal: controller.signal,
  })
  clearTimeout(id)

  if (!response.ok) {
    throw new Error(`Failed to fetch manifest from ${manifestUrl}`)
  }

  return response.json()
}

const isAppManifestValid = (json: unknown): json is AppManifest => {
  return (
    json != null &&
    typeof json === 'object' &&
    'name' in json &&
    'description' in json &&
    ('icons' in json || 'iconPath' in json)
  )
}

const fetchSafeAppFromManifest = async (
  appUrl: string,
  currentChainId: string,
): Promise<SafeAppDataWithPermissions> => {
  const normalizedAppUrl = trimTrailingSlash(appUrl)
  const appManifest = await fetchAppManifest(appUrl)

  if (!isAppManifestValid(appManifest)) {
    throw new Error('Invalid Safe App manifest')
  }

  const iconUrl = getAppLogoUrl(normalizedAppUrl, appManifest)

  return {
    // Must satisfy https://docs.djangoproject.com/en/5.0/ref/models/fields/#positiveintegerfield
    id: Math.round(Math.random() * 1e9 + 1e6),
    url: normalizedAppUrl,
    name: appManifest.name,
    description: appManifest.description,
    accessControl: { type: SafeAppAccessPolicyTypes.NoRestrictions },
    tags: [],
    features: [],
    socialProfiles: [],
    developerWebsite: '',
    chainIds: [currentChainId],
    iconUrl,
    safeAppsPermissions: appManifest.safe_apps_permissions || [],
  }
}

export { fetchAppManifest, isAppManifestValid, getAppLogoUrl, fetchSafeAppFromManifest }

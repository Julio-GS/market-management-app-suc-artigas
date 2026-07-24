export function getOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export function isAllowedRendererNavigation(targetUrl: string, allowedRendererOrigin: string): boolean {
  const targetOrigin = getOrigin(targetUrl);
  return targetOrigin !== null && targetOrigin === allowedRendererOrigin;
}

export function shouldOpenExternally(targetUrl: string, allowedRendererOrigin: string): boolean {
  const targetOrigin = getOrigin(targetUrl);
  if (targetOrigin === null || targetOrigin === allowedRendererOrigin) {
    return false;
  }

  const protocol = new URL(targetUrl).protocol;
  return protocol === "http:" || protocol === "https:";
}

export function isAllowedPermission(permission: string, requestingOrigin: string, allowedRendererOrigin: string): boolean {
  if (requestingOrigin !== allowedRendererOrigin) {
    return false;
  }

  return permission === "media";
}

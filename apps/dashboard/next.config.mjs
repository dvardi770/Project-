/** @type {import('next').NextConfig} */
const nextConfig = {
  // Workspace packages ship TypeScript source.
  transpilePackages: ['@jewelry/db', '@jewelry/platforms'],
  // Prisma loads a native query engine; leave it to Node's own resolution.
  serverExternalPackages: ['@prisma/client'],
  poweredByHeader: false,
};

// Base44 preview only (BASE44_PREVIEW_MODE=1). The sandbox proxy terminates TLS
// and forwards requests with a different host than the browser's Origin, which
// Next's Server Action origin check rejects — sign-in and every other form would
// fail. Allow the preview origins so the dev server accepts them. Unset or any
// other value leaves the configuration untouched.
if (process.env.BASE44_PREVIEW_MODE === '1') {
  const suffix = process.env.BASE44_PUBLIC_HOST_SUFFIX;
  const sandboxDomain = process.env.BASE44_SANDBOX_HOST_DOMAIN;
  nextConfig.allowedDevOrigins = [
    ...(suffix ? [`3000-${suffix}`, `3100-${suffix}`] : []),
    ...(sandboxDomain ? [`*.${sandboxDomain}`] : []),
  ];
  nextConfig.experimental = {
    serverActions: {
      allowedOrigins: [
        ...(suffix ? [`3000-${suffix}`, `3100-${suffix}`] : []),
        ...(sandboxDomain ? [`*.${sandboxDomain}`] : []),
      ],
    },
  };
}

export default nextConfig;

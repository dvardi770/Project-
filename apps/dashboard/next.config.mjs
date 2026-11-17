/** @type {import('next').NextConfig} */
const nextConfig = {
  // Workspace packages ship TypeScript source.
  transpilePackages: ['@jewelry/db', '@jewelry/platforms'],
  // Prisma loads a native query engine; leave it to Node's own resolution.
  serverExternalPackages: ['@prisma/client'],
  poweredByHeader: false,
};

export default nextConfig;

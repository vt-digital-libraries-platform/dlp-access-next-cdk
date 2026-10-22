import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  redirects() {
    return [
      {
        source: '/archive/:uniqueId',
        destination: '/item/:uniqueId',
        permanent: true,
      },
    ]
  },
  output: "standalone",
};

export default nextConfig;

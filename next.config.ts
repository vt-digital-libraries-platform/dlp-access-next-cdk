import type { NextConfig } from "next";

const nextConfig: NextConfig = {
<<<<<<< HEAD
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
=======
  /* config options here */
>>>>>>> 9333d05 (modify config)
};

export default nextConfig;

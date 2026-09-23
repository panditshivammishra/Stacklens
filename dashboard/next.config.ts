import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The floating "N" badge Next.js draws in the corner during `next dev`.
  // Hiding it does NOT hide build or runtime errors — those still take over
  // the screen, which is the part of the dev overlay actually worth keeping.
  devIndicators: false,
};

export default nextConfig;

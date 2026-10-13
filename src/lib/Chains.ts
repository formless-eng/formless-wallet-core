import { Chain } from "viem";
import { base, optimism, polygon } from "viem/chains";

export const NETWORK_ID_BASE = base.id;
export const NETWORK_ID_OPTIMISM = optimism.id;
export const NETWORK_ID_POLYGON = polygon.id;

export const SUPPORTED_CHAINS: Record<number, Chain> = {
  [NETWORK_ID_BASE]: base,
  [NETWORK_ID_POLYGON]: polygon,
  [NETWORK_ID_OPTIMISM]: optimism,
};

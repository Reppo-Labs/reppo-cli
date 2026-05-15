/**
 * Minimal ABIs for the Reppo contract surface the CLI touches.
 *
 * As of PodManager V2 (mainnet impl 0x474d4f03... — verified on basescan),
 * mainnet and testnet share the same PodManager shape:
 * `mintPodWithREPPO(to, subnetId)` / `mintPodWithPrimaryToken(to, subnetId)`
 * for minting, and `vote(podId, votes, upVote)` for voting.
 *
 * The pre-V2 mainnet variant `mintPod(to, emissionSharePercent)` and the
 * `publishingFee()` getter are gone — fee logic moved into SubnetManager
 * (`getAccessFeeREPPO(subnetId)`).
 *
 * The vote selector is unchanged (`vote(uint256,uint256,bool)`) but the
 * second argument's meaning shifted from `subnetId` to `votes` (the voting
 * power to spend on the call). The CLI now requires `--votes <n>`.
 */
import { parseAbi } from 'viem';

export const POD_MANAGER_ABI = parseAbi([
  'function mintPodWithREPPO(address to, uint256 subnetId) returns (uint256 podId)',
  'function mintPodWithPrimaryToken(address to, uint256 subnetId) returns (uint256 podId)',
  'function vote(uint256 podId, uint256 votes, bool upVote)',
  'function claimPodOwnerEmissions(uint256 podId, uint256 epoch)',
  'function claimVoterEmissions(address voter, uint256 podId, uint256 epoch)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function podValid(uint256 podId) view returns (bool)',
  'function getPodValidityEpoch(uint256 podId) view returns (uint256)',
  'function getPodUpVotesOfEpoch(uint256 epoch, uint256 podId) view returns (uint256)',
  'function getPodDownVotesOfEpoch(uint256 epoch, uint256 podId) view returns (uint256)',
  'function hasPodOwnerClaimedEmissions(uint256 epoch, uint256 podId) view returns (bool)',
  'function hasUserClaimedEmissions(uint256 epoch, uint256 podId, address user) view returns (bool)',
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
]);

export const SUBNET_MANAGER_ABI = parseAbi([
  'function accessSubnetWithREPPOFee(uint256 subnetId, address to)',
  'function hasSubnetAccess(uint256 subnetId, address address_) view returns (bool)',
  'function validSubnet(uint256 subnetId) view returns (bool)',
  'function getAccessFeeREPPO(uint256 subnetId) view returns (uint256)',
]);

export const VE_REPPO_ABI = parseAbi([
  'function votingPowerOf(address) view returns (uint256)',
  'function stake(uint256 amount, uint256 duration) returns (uint256 lockupId)',
  'function stakeMore(uint256 lockupId, uint256 amount)',
  'function extendLock(uint256 lockupId, uint256 duration)',
  'function withdraw(uint256 tokenId, address to)',
  'function previewPoints(uint256 amount, uint256 duration) view returns (uint256 points, uint256 end)',
  'function minStakeDuration() view returns (uint256)',
  'function maxStakeDuration() view returns (uint256)',
  'function lockupData(uint256 lockupId) view returns (uint256 amount, uint256 expiresAt, uint256 unused, uint256 votingPower)',
  'function balanceOf(address) view returns (uint256)',
  'function ownerOf(uint256 tokenId) view returns (address)',
]);

export const ERC20_ABI = parseAbi([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);

export const UNISWAP_ROUTER_ABI = parseAbi([
  'function exactOutputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountOut, uint256 amountInMaximum, uint160 sqrtPriceLimitX96)) payable returns (uint256 amountIn)',
  'function multicall(uint256 deadline, bytes[] calldata data) payable returns (bytes[] memory results)',
]);

export const QUOTER_ABI = parseAbi([
  'function quoteExactOutputSingle((address tokenIn, address tokenOut, uint256 amount, uint24 fee, uint160 sqrtPriceLimitX96)) returns (uint256 amountIn, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
]);

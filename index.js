const ethers = require("ethers");
const fs = require("fs");
const readline = require("readline");
const axios = require("axios");

// Constants
const CLAIMS_FILE = "claims.json";
const WALLET_FILE = "wallets.txt";
const FAUCET_API = "https://testnet.somnia.network/api/faucet";
const COOLDOWN_HOURS = 24;
const MAX_CLAIMS_PER_DAY = 10;

// Network configurations
const networks = {
    somnia: {
        name: "Somnia Testnet",
        chainId: 50312,
        rpc: "https://dream-rpc.somnia.network",
        symbol: "STT",
        explorer: "https://somnia-testnet.socialscan.io",
    },
    nexus: {
        name: "Nexus Network",
        chainId: 392,
        rpc: "https://rpc.nexus.xyz/http",
        symbol: "NEX",
        explorer: "https://explorer.nexus.xyz",
    },
};

// Setup readline interface
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
});

const askQuestion = (query) => new Promise((resolve) => rl.question(query, resolve));

// Claim history management
function loadClaimHistory() {
    try {
        if (fs.existsSync(CLAIMS_FILE)) {
            return JSON.parse(fs.readFileSync(CLAIMS_FILE, "utf8"));
        }
        return {
            claims: {},
            dailyCount: 0,
            lastReset: Date.now()
        };
    } catch (error) {
        console.error("Error loading claim history:", error.message);
        return { claims: {}, dailyCount: 0, lastReset: Date.now() };
    }
}

function saveClaimHistory(claimData) {
    try {
        fs.writeFileSync(CLAIMS_FILE, JSON.stringify(claimData, null, 2));
    } catch (error) {
        console.error("Error saving claim history:", error.message);
    }
}

function canClaim(address) {
    const claimData = loadClaimHistory();
    const now = Date.now();

    // Reset daily counter if 24 hours passed
    if ((now - claimData.lastReset) >= (COOLDOWN_HOURS * 60 * 60 * 1000)) {
        claimData.dailyCount = 0;
        claimData.lastReset = now;
        saveClaimHistory(claimData);
    }

    // Check daily limit
    if (claimData.dailyCount >= MAX_CLAIMS_PER_DAY) {
        const nextReset = new Date(claimData.lastReset + (COOLDOWN_HOURS * 60 * 60 * 1000));
        return {
            canClaim: false,
            error: `Daily limit reached (${MAX_CLAIMS_PER_DAY} claims). Reset at ${nextReset.toLocaleString()}`
        };
    }

    // Check individual address cooldown
    const lastClaim = claimData.claims[address];
    if (lastClaim) {
        const hoursSinceLastClaim = (now - lastClaim) / (1000 * 60 * 60);
        if (hoursSinceLastClaim < COOLDOWN_HOURS) {
            const hoursRemaining = Math.ceil(COOLDOWN_HOURS - hoursSinceLastClaim);
            return {
                canClaim: false,
                error: `This address must wait ${hoursRemaining} hours before claiming again.`
            };
        }
    }

    return { canClaim: true };
}

// Core functions
async function claimFaucet(address) {
    try {
        const claimCheck = canClaim(address);
        if (!claimCheck.canClaim) {
            return {
                success: false,
                error: claimCheck.error
            };
        }

        await randomDelay(5, 10);

        const response = await axios.post(
            FAUCET_API,
            { address },
            {
                headers: {
                    "Content-Type": "application/json",
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
                },
            }
        );

        if (response.data.success) {
            const claimData = loadClaimHistory();
            claimData.claims[address] = Date.now();
            claimData.dailyCount++;
            saveClaimHistory(claimData);

            return {
                success: true,
                hash: response.data.data.hash,
                amount: response.data.data.amount,
                remainingClaims: MAX_CLAIMS_PER_DAY - claimData.dailyCount
            };
        }
        return { success: false, error: "Faucet claim failed" };
    } catch (error) {
        if (error.response && error.response.status === 429) {
            return {
                success: false,
                error: "Maximum 10 claims per IP in 24 hours reached."
            };
        }
        return { success: false, error: error.message };
    }
}

async function handleSingleFaucetClaim() {
    try {
        const address = await askQuestion("Enter your wallet address: ");

        if (!ethers.isAddress(address)) {
            console.error("Invalid Ethereum address!");
            return;
        }

        console.log("\nAttempting to claim faucet...");
        const result = await claimFaucet(address);

        if (result.success) {
            console.log(`Claim successful! TX Hash: ${result.hash}`);
            console.log(
                `Amount: ${ethers.formatEther(result.amount)} ${networks.somnia.symbol}`
            );
            console.log(`Remaining claims today: ${result.remainingClaims}`);
        } else {
            console.log(`Claim failed: ${result.error}`);
        }
    } catch (error) {
        console.error("Error:", error.message);
    }
}

async function checkClaimStatus() {
    try {
        const claimData = loadClaimHistory();
        const now = Date.now();
        
        console.log("\n=== Faucet Claim Status ===");
        console.log(`Daily Claims Used: ${claimData.dailyCount}/${MAX_CLAIMS_PER_DAY}`);
        
        if (claimData.dailyCount >= MAX_CLAIMS_PER_DAY) {
            const nextReset = new Date(claimData.lastReset + (COOLDOWN_HOURS * 60 * 60 * 1000));
            console.log(`Next Reset: ${nextReset.toLocaleString()}`);
        } else {
            console.log(`Remaining Claims Today: ${MAX_CLAIMS_PER_DAY - claimData.dailyCount}`);
        }

        const address = await askQuestion("\nEnter wallet address to check specific status: ");

        if (!ethers.isAddress(address)) {
            console.error("Invalid Ethereum address!");
            return;
        }

        const claimCheck = canClaim(address);
        if (claimCheck.canClaim) {
            console.log("\nThis address is eligible to claim!");
        } else {
            console.log(`\n${claimCheck.error}`);
        }
    } catch (error) {
        console.error("Error:", error.message);
    }
}

// Utility functions
function randomDelay(min, max) {
    const delay = (Math.floor(Math.random() * (max - min + 1)) + min) * 1000;
    return new Promise((resolve) => setTimeout(resolve, delay));
}

function generateNewWallet() {
    const wallet = ethers.Wallet.createRandom();
    return {
        address: wallet.address,
        privateKey: wallet.privateKey,
    };
}

function saveWalletToFile(address, privateKey) {
    const walletData = `${address}:${privateKey}\n`;
    fs.appendFileSync(WALLET_FILE, walletData);
}

function generateNewWallet() {
  const wallet = ethers.Wallet.createRandom();
  return {
    address: wallet.address,
    privateKey: wallet.privateKey,
  };
}

async function claimFaucet(address) {
  try {
    await randomDelay(5, 10); // Delay 5-10 detik

    const response = await axios.post(
      FAUCET_API,
      {
        address: address,
      },
      {
        headers: {
          "Content-Type": "application/json",
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
        },
      }
    );

    if (response.data.success) {
      return {
        success: true,
        hash: response.data.data.hash,
        amount: response.data.data.amount,
      };
    }
    return { success: false, error: "Faucet claim failed" };
  } catch (error) {
    // handling error 429
    if (error.response && error.response.status === 429) {
      return {
        success: false,
        error:
          "Rate limit reached. Please wait 24 hours before trying again.",
      };
    }
    return { success: false, error: error.message };
  }
}

async function handleFaucetClaims() {
  try {
    const numWallets = parseInt(
      await askQuestion(
        "How many wallets do you want to generate for faucet claims? "
      )
    );

    if (isNaN(numWallets) || numWallets <= 0) {
      console.error("Number of wallets must be a positive number!");
      return;
    }

    console.log("\nStarting wallet generation and faucet claim process...");
    console.log(`Wallets will be saved to: ${WALLET_FILE}\n`);

    for (let i = 0; i < numWallets; i++) {
      const wallet = generateNewWallet();
      console.log(`\nWallet ${i + 1}/${numWallets}:`);
      console.log(`Address: ${wallet.address}`);

      saveWalletToFile(wallet.address, wallet.privateKey);

      console.log("Attempting to claim faucet...");
      const result = await claimFaucet(wallet.address);

      if (result.success) {
        console.log(`Claim successful! TX Hash: ${result.hash}`);
        console.log(
          `Amount: ${ethers.formatEther(result.amount)} ${
            networks.somnia.symbol
          }`
        );
      } else {
        console.log(`Claim failed: ${result.error}`);
      }

      if (i < numWallets - 1) {
        console.log("\nWaiting 5 seconds before next wallet...");
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }

    console.log("\nProcess completed!");
    console.log(`Total wallets generated: ${numWallets}`);
    console.log(`Wallets saved to: ${WALLET_FILE}`);
  } catch (error) {
    console.error("Error:", error.message);
  }
}

async function handleTokenTransfers(network) {
  try {
    const privateKey = fs.readFileSync("pk.txt", "utf8").trim();
    const provider = new ethers.JsonRpcProvider(networks[network].rpc);
    const wallet = new ethers.Wallet(privateKey, provider);

    console.log(`\nSelected Network: ${networks[network].name}`);
    console.log(`Token Symbol: ${networks[network].symbol}`);

    const amountPerTx = await askQuestion(
      "Enter amount of tokens per transaction: "
    );
    const numberOfTx = await askQuestion(
      "Enter number of transactions to perform: "
    );
    const minDelay = await askQuestion(
      "Enter minimum delay (seconds) between transactions: "
    );
    const maxDelay = await askQuestion(
      "Enter maximum delay (seconds) between transactions: "
    );

    if (
      isNaN(amountPerTx) ||
      isNaN(numberOfTx) ||
      isNaN(minDelay) ||
      isNaN(maxDelay)
    ) {
      console.error("All inputs must be numbers!");
      return;
    }

    for (let i = 0; i < numberOfTx; i++) {
      console.log(`\nProcessing transaction ${i + 1} of ${numberOfTx}`);

      const newWallet = generateNewWallet();
      console.log(`Generated recipient address: ${newWallet.address}`);
      saveWalletToFile(newWallet.address, newWallet.privateKey);

      const tx = {
        to: newWallet.address,
        value: ethers.parseEther(amountPerTx.toString()),
      };

      const transaction = await wallet.sendTransaction(tx);
      console.log(`Transaction sent: ${transaction.hash}`);
      console.log(
        `View on explorer: ${networks[network].explorer}/tx/${transaction.hash}`
      );

      await transaction.wait();

      if (i < numberOfTx - 1) {
        await randomDelay(parseInt(minDelay), parseInt(maxDelay));
      }
    }

    console.log("\nAll transactions completed successfully!");
  } catch (error) {
    console.error("Error:", error.message);
  }
}

//added opsion single claim
async function showMenu() {
  while (true) {
    console.log("\n=== MULTI-NETWORK CRYPTO BOT | AIRDROP INSIDERS ===");
    console.log("1. Claim Faucet (Single Wallet)");
    console.log("2. Generate Wallets & Claim Faucet (Somnia)");
    console.log("3. Transfer STT Tokens (Somnia)");
    console.log("4. Transfer NEX Tokens (Nexus)");
    console.log("5. Check Faucet Claim Status");
    console.log("6. Exit");

    const choice = await askQuestion("\nSelect menu (1-6): ");

    switch (choice) {
      case "1":
        await handleSingleFaucetClaim();
        break;
      case "2":
        await handleFaucetClaims();
        break;
      case "3":
        await handleTokenTransfers("somnia");
        break;
      case "4":
        await handleTokenTransfers("nexus");
        break;
      case "5":
        await checkClaimStatus();
        break;
      case "6":
        console.log("Thank you for using this bot!");
        rl.close();
        process.exit(0);
      default:
        console.log("Invalid choice!");
    }
  }
}

console.log("Starting Multi-Network Bot...");
showMenu().catch(console.error);

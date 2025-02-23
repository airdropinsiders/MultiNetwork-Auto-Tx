const ethers = require("ethers");
const fs = require("fs");
const readline = require("readline");
const axios = require("axios");

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

const WALLET_FILE = "wallets.txt";
const FAUCET_API = "https://testnet.somnia.network/api/faucet";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

const askQuestion = (query) =>
  new Promise((resolve) => rl.question(query, resolve));

async function handleSingleFaucetClaim() {
  try {
    const address = await askQuestion("Enter your wallet address: ");

    if (!ethers.isAddress(address)) {
      console.error("Invalid Ethereum address!");
      return;
    }

    console.log("\nAttempting to claim faucet...");
    let attempts = 0;
    const maxAttempts = 3;

    while (attempts < maxAttempts) {
      const result = await claimFaucet(address);

      if (result.success) {
        console.log(`Claim successful! TX Hash: ${result.hash}`);
        console.log(
          `Amount: ${ethers.formatEther(result.amount)} ${
            networks.somnia.symbol
          }`
        );
        return;
      } else if (result.error.includes("429")) {
        attempts++;
        if (attempts < maxAttempts) {
          const waitTime = 60; // 1 minute
          console.log(
            `Rate limit reached. Waiting ${waitTime} seconds before retry... (Attempt ${attempts}/${maxAttempts})`
          );
          await new Promise((resolve) => setTimeout(resolve, waitTime * 1000));
        } else {
          console.log(
            "Maximum retry attempts reached. Please try again later."
          );
        }
      } else {
        console.log(`Claim failed: ${result.error}`);
        return;
      }
    }
  } catch (error) {
    console.error("Error:", error.message);
  }
}

function randomDelay(min, max) {
  const delay = (Math.floor(Math.random() * (max - min + 1)) + min) * 1000;
  return new Promise((resolve) => setTimeout(resolve, delay));
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
          "Rate limit reached. Please wait 15-30 minutes before trying again.",
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
    console.log("5. Exit");

    const choice = await askQuestion("\nSelect menu (1-5): ");

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

const ethers = require('ethers');
const fs = require('fs');
const readline = require('readline');
const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');

const config = JSON.parse(fs.readFileSync('config.json', 'utf8'));
const networks = config.networks;

const WALLET_FILE = 'wallets.txt';
const PK_FILE = 'pk.txt';
const PROXY_FILE = 'proxies.txt';
const FAUCET_API = networks.somnia.faucetApi;

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const askQuestion = (query) => new Promise(resolve => rl.question(query, resolve));

// Proxy Management
function loadProxies() {
    try {
        const content = fs.readFileSync(PROXY_FILE, 'utf8');
        return content.split('\n')
            .map(line => line.trim())
            .filter(line => line && line.length > 0);
    } catch (error) {
        console.error('Error loading proxies:', error.message);
        return [];
    }
}

function getRandomProxy(proxies) {
    if (!proxies.length) return null;
    return proxies[Math.floor(Math.random() * proxies.length)];
}

function createProxyAgent(proxy) {
    if (!proxy) return null;
    
    const [auth, hostPort] = proxy.includes('@') ? proxy.split('@') : [null, proxy];
    const [host, port] = hostPort ? hostPort.split(':') : proxy.split(':');
    
    const proxyOptions = {
        host,
        port: parseInt(port),
        ...(auth && {
            auth: auth.includes(':') ? auth : `${auth}:`
        })
    };

    if (proxy.startsWith('socks4://') || proxy.startsWith('socks5://')) {
        const proxyType = proxy.startsWith('socks5') ? 'SOCKS5' : 'SOCKS4';
        console.log(`Proxy ${proxyType} dari proxies.txt digunakan: ${proxy}`);
        return new SocksProxyAgent(`socks${proxy.startsWith('socks5') ? 5 : 4}://${proxy.replace(/^socks[4-5]:\/\//, '')}`);
    }
    console.log(`Proxy HTTP dari proxies.txt digunakan: ${proxy}`);
    return new HttpsProxyAgent(`http://${proxy}`);
}

// Enhanced HTTP client with proxy support and retry logic
async function makeRequest(url, options = {}, retries = 3) {
    const proxies = loadProxies();
    let proxy = getRandomProxy(proxies);
    let attempt = 0;

    while (attempt < retries) {
        const agent = proxy ? createProxyAgent(proxy) : null;
        if (!proxy) {
            console.log('Tidak ada proxy yang digunakan untuk permintaan ini');
        }

        try {
            const response = await axios({
                url,
                ...options,
                timeout: 10000, // Set timeout to 10 seconds
                ...(agent && { httpsAgent: agent, httpAgent: agent })
            });
            return response;
        } catch (error) {
            attempt++;
            if (error.code === 'EAI_AGAIN') {
                console.error(`Kesalahan EAI_AGAIN pada percobaan ${attempt}/${retries} dengan proxy: ${proxy || 'tanpa proxy'}`);
                if (attempt < retries) {
                    console.log('Mencoba lagi dengan proxy lain...');
                    proxy = getRandomProxy(proxies); // Ganti proxy untuk percobaan berikutnya
                    await new Promise(resolve => setTimeout(resolve, 2000)); // Tunggu 2 detik sebelum retry
                    continue;
                }
            }
            throw new Error(`Request failed setelah ${retries} percobaan${proxy ? ' dengan proxy ' + proxy : ''}: ${error.message}`);
        }
    }
}

function loadPrivateKeys() {
    try {
        const content = fs.readFileSync(PK_FILE, 'utf8');
        return content.split('\n')
            .map(line => line.trim())
            .filter(line => line && line.length > 0);
    } catch (error) {
        console.error('Error loading private keys:', error.message);
        return [];
    }
}

async function selectWallet(network) {
    const privateKeys = loadPrivateKeys();
    if (privateKeys.length === 0) {
        throw new Error('No private keys found in pk.txt');
    }

    console.log('\n=== Available Wallets ===');
    const provider = new ethers.JsonRpcProvider(networks[network].rpc);
    
    const wallets = await Promise.all(privateKeys.map(async (pk, index) => {
        const wallet = new ethers.Wallet(pk, provider);
        const balance = await provider.getBalance(wallet.address);
        return {
            index,
            address: wallet.address,
            privateKey: pk,
            balance: ethers.formatEther(balance)
        };
    }));

    wallets.forEach((wallet, index) => {
        console.log(`${index + 1}. Address: ${wallet.address}`);
        console.log(`   Balance: ${wallet.balance} ${networks[network].symbol}\n`);
    });

    const selection = parseInt(await askQuestion('Select wallet (enter number): ')) - 1;
    if (selection < 0 || selection >= wallets.length) {
        throw new Error('Invalid wallet selection');
    }

    return wallets[selection];
}

function randomDelay(min, max) {
    const delay = (Math.floor(Math.random() * (max - min + 1)) + min) * 1000;
    console.log(`Waiting ${delay/1000} seconds before next transaction...`);

    return new Promise(resolve => setTimeout(resolve, delay));
}

function saveWalletToFile(address, privateKey) {
    const walletData = `${address}:${privateKey}\n`;
    fs.appendFileSync(WALLET_FILE, walletData);
}

function generateNewWallet() {
    const wallet = ethers.Wallet.createRandom();
    return {
        address: wallet.address,
        privateKey: wallet.privateKey
    };
}

async function claimFaucet(address) {
    try {
        const response = await makeRequest(FAUCET_API, {
            method: 'POST',
            data: { address },
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36'
            }
        });

        if (response.data.success) {
            return {
                success: true,
                hash: response.data.data.hash,
                amount: response.data.data.amount
            };
        }
        return { success: false, error: 'Faucet claim failed' };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

async function handleFaucetClaims() {
    try {
        console.log(`Loading proxies from ${PROXY_FILE}...`);
        const proxies = loadProxies();
        console.log(`Found ${proxies.length} proxies`);
        
        const numWallets = parseInt(await askQuestion('How many wallets do you want to generate for faucet claims? '));
        
        if (isNaN(numWallets) || numWallets <= 0) {
            console.error('Number of wallets must be a positive number!');
            return;
        }

        console.log('\nStarting wallet generation and faucet claim process...');
        console.log(`Wallets will be saved to: ${WALLET_FILE}\n`);

        for (let i = 0; i < numWallets; i++) {
            const wallet = generateNewWallet();
            console.log(`\nWallet ${i + 1}/${numWallets}:`);
            console.log(`Address: ${wallet.address}`);
            
            saveWalletToFile(wallet.address, wallet.privateKey);
            
            console.log('Attempting to claim faucet...');
            const result = await claimFaucet(wallet.address);
            
            if (result.success) {
                console.log(`Claim successful! TX Hash: ${result.hash}`);
                console.log(`Amount: ${ethers.formatEther(result.amount)} ${networks.somnia.symbol}`);
            } else {
                console.log(`Claim failed: ${result.error}`);
            }

            if (i < numWallets - 1) {
                console.log('\nWaiting 5 seconds before next wallet...');
                await new Promise(resolve => setTimeout(resolve, 5000));
            }
        }

        console.log('\nProcess completed!');
        console.log(`Total wallets generated: ${numWallets}`);
        console.log(`Wallets saved to: ${WALLET_FILE}`);
    } catch (error) {
        console.error('Error:', error.message);
    }
}

async function handleTokenTransfers(network) {
    try {
        const selectedWallet = await selectWallet(network);
        const provider = new ethers.JsonRpcProvider(networks[network].rpc);
        const wallet = new ethers.Wallet(selectedWallet.privateKey, provider);
        
        console.log(`\nSelected Network: ${networks[network].name}`);
        console.log(`Token Symbol: ${networks[network].symbol}`);
        console.log(`Using wallet: ${selectedWallet.address}`);
        
        const amountPerTx = await askQuestion('Enter amount of tokens per transaction: ');
        const numberOfTx = await askQuestion('Enter number of transactions to perform: ');
        const minDelay = await askQuestion('Enter minimum delay (seconds) between transactions: ');
        const maxDelay = await askQuestion('Enter maximum delay (seconds) between transactions: ');
        
        if (isNaN(amountPerTx) || isNaN(numberOfTx) || isNaN(minDelay) || isNaN(maxDelay)) {
            console.error('All inputs must be numbers!');
            return;
        }

        for (let i = 0; i < numberOfTx; i++) {
            console.log(`\nProcessing transaction ${i + 1} of ${numberOfTx}`);
            
            const newWallet = generateNewWallet();
            console.log(`Generated recipient address: ${newWallet.address}`);
            saveWalletToFile(newWallet.address, newWallet.privateKey);
            
            const tx = {
                to: newWallet.address,
                value: ethers.parseEther(amountPerTx.toString())
            };

            const transaction = await wallet.sendTransaction(tx);
            console.log(`Transaction sent: ${transaction.hash}`);
            console.log(`View on explorer: ${networks[network].explorer}/tx/${transaction.hash}`);
            
            await transaction.wait();
            
            if (i < numberOfTx - 1) {
                await randomDelay(parseInt(minDelay), parseInt(maxDelay));
            }
        }

        console.log('\nAll transactions completed successfully!');
    } catch (error) {
        console.error('Error:', error.message);
    }
}

async function checkLayerhubActivity(address) {
    try {
        const response = await makeRequest(`https://layerhub.xyz/be-api/wallets/monad_testnet/${address}`, {
            method: 'GET',
            headers: {
                'Accept': '*/*',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept-Encoding': 'gzip, deflate, br, zstd',
                'Connection': 'keep-alive',
                'Sec-Fetch-Dest': 'empty',
                'Sec-Fetch-Mode': 'cors',
                'Sec-Fetch-Site': 'same-origin',
                'Content-Type': 'application/json'
            }
        });
        
        return response.data;
    } catch (error) {
        console.error('Error checking Layerhub activity:', error.message);
        return null;
    }
}

const stakingAbi = [
    "function stake() payable",
    "function approve(address spender, uint256 amount) returns (bool)",
    "function transfer(address to, uint256 amount) returns (bool)",
    "function withdraw(uint256 amount) external returns (bool)",
    {
        name: 'withdrawWithSelector',
        type: 'function',
        stateMutability: 'nonpayable',
        inputs: [{ type: 'uint256', name: 'amount' }],
        outputs: [{ type: 'bool' }],
        selector: '0x30af6b2e'
    }
];

const molandakAbi = [
    "function stake(uint256 _poolId) payable"
];

async function stakeMolandakhubQuest(wallet) {
    try {
        const stakeAmount = ethers.parseEther('0.1');
        const STAKING_CONTRACT = '0xc803D3Cbe1B4811442a4502153685a235Ea90741';
        const POOL_ID = 2;

        const questContract = new ethers.Contract(
            STAKING_CONTRACT,
            molandakAbi,
            wallet
        );

        console.log('\nStaking 0.1 MON for Molandakhub Quest...');
        
        const balance = await wallet.provider.getBalance(wallet.address);
        if (balance < stakeAmount) {
            throw new Error('Insufficient balance for staking');
        }

        const stakeTx = await questContract.stake(POOL_ID, {
            value: stakeAmount,
            gasLimit: 1000000,
            maxFeePerGas: ethers.parseUnits('61.5', 'gwei'),
            maxPriorityFeePerGas: ethers.parseUnits('1.5', 'gwei')
        });

        console.log(`Transaction sent: ${stakeTx.hash}`);
        console.log(`View on explorer: ${networks.monad.explorer}/tx/${stakeTx.hash}`);
        
        const receipt = await stakeTx.wait();
        
        if (receipt.status === 1) {
            console.log('Quest staking successful!');
            return true;
        } else {
            console.log('Quest staking failed!');
            return false;
        }
    } catch (error) {
        console.error('Quest staking error:', error.message);
        return false;
    }
}

async function handleMonadStaking() {
    try {
        const selectedWallet = await selectWallet('monad');
        const provider = new ethers.JsonRpcProvider(networks.monad.rpc);
        const wallet = new ethers.Wallet(selectedWallet.privateKey, provider);
        
        console.log('\n=== Monad Staking Operations ===');
        console.log(`Using wallet: ${selectedWallet.address}`);
        console.log('1. Stake MON on kitsu.xyz');
        console.log('2. Unstake MON on kitsu.xyz');
        console.log('3. Stake 0.1 MON (Molandakhub Quest)');
        console.log('4. Check Wallet Activity Rank');
        console.log('0. Back');

        const choice = await askQuestion('\nSelect operation: ');

        const stakingContract = new ethers.Contract(
            networks.monad.contracts.staking,
            stakingAbi,
            wallet
        );

        switch (choice) {
            case '1':
                const amountToStake = await askQuestion('Enter amount of MON to stake: ');
                
                if (isNaN(amountToStake) || amountToStake <= 0) {
                    console.error('Invalid amount!');
                    return;
                }

                console.log(`\nStaking ${amountToStake} MON...`);
                
                try {
                    const balance = await provider.getBalance(wallet.address);
                    const stakeAmount = ethers.parseEther(amountToStake.toString());
                    
                    if (balance < stakeAmount) {
                        console.error('Insufficient balance for staking');
                        return;
                    }

                    const stakeTx = await stakingContract.stake({
                        value: stakeAmount
                    });

                    console.log(`Transaction sent: ${stakeTx.hash}`);
                    console.log(`View on explorer: ${networks.monad.explorer}/tx/${stakeTx.hash}`);
                    
                    const stakeReceipt = await stakeTx.wait();
                    console.log('\nStaking transaction confirmed!');
                    
                    if (stakeReceipt.status === 1) {
                        console.log('Staking successful!');
                    } else {
                        console.log('Staking failed!');
                    }
                } catch (error) {
                    console.error('Staking error:', error.message);
                }
                break;

            case '2':
                const amountToUnstake = await askQuestion('Enter amount of sMON to unstake: ');
                
                if (isNaN(amountToUnstake) || amountToUnstake <= 0) {
                    console.error('Invalid amount!');
                    return;
                }

                console.log(`\nUnstaking ${amountToUnstake} sMON...`);
                
                try {
                    const data = ethers.concat([
                        '0x30af6b2e',
                        ethers.AbiCoder.defaultAbiCoder().encode(
                            ['uint256'],
                            [ethers.parseEther(amountToUnstake.toString())]
                        )
                    ]);

                    const unstakeTx = await wallet.sendTransaction({
                        to: networks.monad.contracts.staking,
                        data: data,
                        gasLimit: 300000
                    });

                    console.log(`Transaction sent: ${unstakeTx.hash}`);
                    console.log(`View on explorer: ${networks.monad.explorer}/tx/${unstakeTx.hash}`);
                    
                    const unstakeReceipt = await unstakeTx.wait();
                    console.log('\nUnstaking transaction confirmed!');
                    
                    if (unstakeReceipt.status === 1) {
                        console.log('Unstaking successful!');
                    } else {
                        console.log('Unstaking failed!');
                    }
                } catch (error) {
                    console.error('Unstaking error:', error.message);
                }
                break;

            case '3':
                await stakeMolandakhubQuest(wallet);
                break;

            case '4':
                console.log('\nChecking wallet activity...');
                const activityData = await checkLayerhubActivity(wallet.address);
                if (activityData) {
                    console.log('\nWallet Activity Information:');
                    console.log(`Address: ${wallet.address}`);
                    console.log(`Total Transactions: ${activityData.totalTx || 'N/A'}`);
                    console.log(`First Transaction: ${activityData.firstTx || 'N/A'}`);
                    console.log(`Last Transaction: ${activityData.lastTx || 'N/A'}`);
                    if (activityData.rank) {
                        console.log(`Activity Rank: ${activityData.rank}`);
                    }
                } else {
                    console.log('Could not fetch activity data');
                }
                break;

            case '0':
                return;

            default:
                console.log('Invalid choice!');
                break;
        }
    } catch (error) {
        console.error('Error:', error.message);
    }
}

async function handleNetworkOperations(network) {
    while (true) {
        console.log(`\n=== ${networks[network].name} Operations ===`);
        if (network === 'somnia') {
            console.log('1. Generate Wallets & Claim Faucet');
            console.log('2. Transfer Tokens');
        } else if (network === 'monad') {
            console.log('1. Transfer Tokens');
            console.log('2. Staking Operations');
        } else if (network === 'nexus') {
            console.log('1. Transfer Tokens');
        } else if (network === 'zeroGravity') { // Baris khusus untuk 0G Testnet
            console.log('1. Transfer Tokens');
        }
        console.log('0. Back to Network Selection');

        const choice = await askQuestion('\nSelect operation: ');

        switch (network) {
            case 'somnia':
                switch (choice) {
                    case '1':
                        await handleFaucetClaims();
                        break;
                    case '2':
                        await handleTokenTransfers('somnia');
                        break;
                    case '0':
                        return;
                    default:
                        console.log('Invalid choice!');
                }
                break;

            case 'monad':
                switch (choice) {
                    case '1':
                        await handleTokenTransfers('monad');
                        break;
                    case '2':
                        await handleMonadStaking();
                        break;
                    case '0':
                        return;
                    default:
                        console.log('Invalid choice!');
                }
                break;

            case 'nexus':
                switch (choice) {
                    case '1':
                        await handleTokenTransfers('nexus');
                        break;
                    case '0':
                        return;
                    default:
                        console.log('Invalid choice!');
                }
                break;

            case 'zeroGravity': // Blok khusus untuk 0G Testnet
                switch (choice) {
                    case '1':
                        await handleTokenTransfers('zeroGravity');
                        break;
                    case '0':
                        return;
                    default:
                        console.log('Invalid choice!');
                }
                break;
        }
    }
}

async function showMenu() {
    while (true) {
        console.log('\n=== MULTI-NETWORK CRYPTO BOT | AIRDROP INSIDERS ===');
        console.log('1. Somnia Network');
        console.log('2. Monad Network');
        console.log('3. Nexus Network');
        console.log('4. 0G Testnet');
        console.log('5. Exit');
        
        const choice = await askQuestion('\nSelect network (1-5): ');
        
        switch (choice) {
            case '1':
                await handleNetworkOperations('somnia');
                break;
            case '2':
                await handleNetworkOperations('monad');
                break;
            case '3':
                await handleNetworkOperations('nexus');
                break;
            case '4':
                await handleNetworkOperations('zeroGravity');
                break;
            case '5':
                console.log('Thank you for using this bot!');
                rl.close();
                process.exit(0);
            default:
                console.log('Invalid choice!');
        }
    }
}

// Start the application
console.log('Starting Multi-Network Bot...');
showMenu().catch(console.error);

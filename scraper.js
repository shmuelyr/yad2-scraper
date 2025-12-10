const cheerio = require('cheerio');
const Telenode = require('telenode-js');
const fs = require('fs');
const config = require('./config.json');

const getYad2Response = async (url) => {
    const requestOptions = {
        method: 'GET',
        redirect: 'follow',
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36',
            'Accept': 'application/json, text/plain, */*',
            'Accept-Encoding': 'gzip, deflate, br',
            'Accept-Language': 'en-US,en;q=0.9',
        }
    };
    try {
        const res = await fetch(url, requestOptions)
        return await res.text()
    } catch (err) {
        console.log(err)
    }
}

const types = {
    CARS: 'cars',
    NADLAN: 'nadlan',
    UNKNOWN: 'x'
};

const stages = {
    // [1] feed container, [2] image selector, [3] link selector
    [types.CARS]: ["div[class^=results-feed_feedListBox]", "div[class*=promotion-layout][class*=imageBox]", "a[href*=item][class]:not([class*=look])"],
    [types.NADLAN]: ["div[class^=map-feed_mapFeedBox]", "div[class^=item-image_itemImageBox]", "div[class^=item-layout_feedItemBox]"],
    [types.UNKNOWN]: []
};

const is_not_ad = (imgSrc, lnkSrc) => {
    const img_keywords = ["project", "cdn.", ".treedis"]
    if (img_keywords.filter(x => imgSrc.includes(x)).length > 0) {
        return false;
    }
    return true;
}

const scrapeItemsAndExtractImgUrls = async (url) => {
    const yad2Html = await getYad2Response(url);
    if (!yad2Html) {
        throw new Error("Could not get Yad2 response");
    }
    const $ = cheerio.load(yad2Html);
    const title = $("title")
    const titleText = title.first().text();
    if (titleText === "ShieldSquare Captcha") {
        throw new Error("Bot detection");
    }

    let type = types.UNKNOWN;
    if ($(stages[types.CARS][0]).length != 0) {
        type = types.CARS;
    } else if ($(stages[types.NADLAN][0]).length != 0) {
        type = types.NADLAN;
    } else {
        throw new Error("Unknown type");
    }

    const $feedItems = $(stages[type][0]);
    if ($feedItems.length == 0) {
        throw new Error("Could not find feed items");
    }
    const $imageList = $feedItems.find(stages[type][1]);
    const $linkList = $feedItems.find(stages[type][2]);

    if ($imageList == 0 || $imageList.length != $linkList.length) {
        throw new Error(`Could not read lists properly`);
    }

    const data = []
    $imageList.each((i, _) => {
        const imgSrc = $($imageList[i]).find("img").attr('src');
        const lnkSrc = $($linkList[i]).attr('href');

        if (imgSrc && lnkSrc && is_not_ad(imgSrc, lnkSrc)) {
            data.push({'img':imgSrc, 'lnk':  new URL(lnkSrc, url).href})
        } else {
            console.log(`Skipped on: ${imgSrc} - ${lnkSrc}`);
        }
    })
    return data;
}

const checkIfHasNewItem = async (data, topic) => {
    const filePath = `./data/${topic}.json`;
    let savedUrls = [];
    try {
        savedUrls = require(filePath);
    } catch (e) {
        if (e.code === "MODULE_NOT_FOUND") {
            if (!fs.existsSync('data')) {
                fs.mkdirSync('data');
            }
            fs.writeFileSync(filePath, '[]');
        } else {
            console.log(e);
            throw new Error(`Could not read / create ${filePath}`);
        }
    }
    let shouldUpdateFile = false;
    let imgUrls = data.map(a => a['img']);
    savedUrls = savedUrls.filter(savedUrl => {
        return imgUrls.includes(savedUrl);
    });
    const newItems = [];
    data.forEach(url => {
        if (!savedUrls.includes(url['img'])) {
            savedUrls.push(url['img']);
            newItems.push({'lnk': url['lnk'], 'img': url['img']});
            shouldUpdateFile = true;
        }
    });
    if (shouldUpdateFile) {
        const updatedUrls = JSON.stringify(savedUrls, null, 2);
        fs.writeFileSync(filePath, updatedUrls);
        await createPushFlagForWorkflow();
    }
    return newItems;
}

const createPushFlagForWorkflow = () => {
    fs.writeFileSync("push_me", "")
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

const sendMsgRetry = async (telenode, msg, chatId, retry = 3) => {
    return telenode.sendTextMessage(msg, chatId)
        .catch(e => {
            if (retry > 0) {
                return sleep(1000)
                    .then(_ => sendMsgRetry(telenode, msg, chatId, retry - 1));
            } else {
                // not fail on network error.. we will remove the item
                // from our backup and we will try again next time.
                return false;
            }
        });
}

const removeFromDB = async (data, topic) => {
    const filePath = `./data/${topic}.json`;
    let savedUrls = [];
    try {
        savedUrls = require(filePath);
    } catch (e) {
        if (e.code === "MODULE_NOT_FOUND") {
            return;
        } else {
            console.log(e);
            throw new Error(`Could not read / create ${filePath}`);
        }
    }
    let size = savedUrls.length;
    savedUrls = savedUrls.map(x => { return data.includes(x) ? undefined : x }).filter(x => x);
    if (size != savedUrls.size) {
        const updatedUrls = JSON.stringify(savedUrls, null, 2);
        fs.writeFileSync(filePath, updatedUrls);
        createPushFlagForWorkflow();
    }
}

const scrape = async (topic, url) => {
    const apiToken = process.env.API_TOKEN || config.telegramApiToken;
    const chatId = process.env.CHAT_ID || config.chatId;
    const telenode = new Telenode({apiToken})
    try {
        // await telenode.sendTextMessage(`Starting scanning ${topic} on link:\n${url}`, chatId)
        const scrapeDataResults = await scrapeItemsAndExtractImgUrls(url);
        const newItems = await checkIfHasNewItem(scrapeDataResults, topic);
        if (newItems.length > 0) {
            let i = 1;
            let notSend = [];
            Promise.all(
                newItems.map(msg => sendMsgRetry(telenode,
                    `${topic}:${i++}/${newItems.length} ${msg['lnk']}`, chatId).then(r => {
                    if (r == false) {
                         notSend.push(msg['img']);
                    }
                })));
            removeFromDB(notSend);
        } else {
            // await telenode.sendTextMessage("No new items were added", chatId);
        }
    } catch (e) {
        let errMsg = e?.message || "";
        if (errMsg) {
            errMsg = `Error: ${errMsg}`
        }
        await telenode.sendTextMessage(`Scan workflow failed... 😥\n${errMsg}`, chatId)
        throw new Error(e)
    }
}

const program = async () => {
    await Promise.all(config.projects.filter(project => {
        if (project.disabled) {
            console.log(`Topic "${project.topic}" is disabled. Skipping.`);
        }
        return !project.disabled;
    }).map(async project => {
        await scrape(project.topic, project.url)
    }))
};

program();

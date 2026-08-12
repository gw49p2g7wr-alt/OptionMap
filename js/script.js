console.log("script.js 読み込み成功！");

let myChart = null;
let futureOpenInterestChart = null;
let latestFutureOpenInterestResult = null;
window.setLatestFutureOpenInterestResult = function (result) {
    console.log("★ setter受信 =", result);
    latestFutureOpenInterestResult = result;

    updateFutureOpenInterestExpiryOptions(
        futureOpenInterestProduct.value
    );

    drawFutureOpenInterestChart(
        futureOpenInterestProduct.value,
        futureOpenInterestExpiry.value
    );

    console.log(
        "週次先物データをグラフへ反映:",
        latestFutureOpenInterestResult
    );
};


let latestBrokerLabels = [];
let latestBrokerValues = [];
let latestNightBrokerData = {};
let latestDayBrokerData = {};
let latestOptionBrokerData = {};
let priceChart = null;
let combinedPriceChart = null;
let latestJpxLabels = [];
let latestCallValues = [];
let latestPutValues = [];
let optionMap = {};
window.setWeeklyOptionMap = function (result) {
    optionMap = result?.optionMap || {};

    console.log(
        "週次オプションを価格帯マップへ反映:",
        optionMap
    );

    drawOptionTable();
    showMaxPosition(result?.priceTotals || {});
    showPriceRanking();
};
let allJpxLabels = [];
let allJpxCallValues = [];
let allJpxPutValues = [];
let allJpxCallVolumes = [];
let allJpxPutVolumes = [];
let currentChartMode = "openInterest";
let lastJpxFetchedAt = null;
let priceTotals = {};
let comparisonSnapshot = null;
let latestNightFutureTotals = null;
let latestDayFutureTotals = null;
let latestParsedDayData = null;

const companyNames = {
    "ＡＢＮクリアリン証券": "ABN",
    "ソシエテＧ証券": "SG",
    "バークレイズ証券": "Barclays",
    "ＳＢＩ証券": "SBI",
    "楽天証券": "Rakuten",
    "ＪＰモルガン証券": "JPM",
    "ゴールドマン証券": "Goldman",
    "ビーオブエー証券": "BofA",
    "日産証券": "Nissan",
    "フィリップ証券": "Phillip",
    "松井証券": "Matsui",
    "みずほ証券": "Mizuho",
    "野村証券": "Nomura",
    "モルガンＭＵＦＧ証券": "MorganMUFG",
    "マネックス証券": "Monex",
    "インタラクティブ証券": "IB",
    "ＵＢＳ証券": "UBS",
    "シティグループ証券": "Citi",
    "ＨＳＢＣ証券": "HSBC",
    "ドイツ証券": "Deutsche",
    "ＢＮＰパリバ証券": "BNP",
    "三菱ＵＦＪ証券": "MUFG",
    "光世証券": "Kosei",
    "ＳＭＢＣ日興証券": "SMBC"
};

const button = document.getElementById("analyzeButton");
const nightData = document.getElementById("nightData");
const dayData = document.getElementById("dayData");
const optionData = document.getElementById("optionData");
const futureOpenInterestData =
  document.getElementById("futureOpenInterestData");
const futureOpenInterestProduct =
  document.getElementById("futureOpenInterestProduct");
const futureOpenInterestExpiry =
  document.getElementById("futureOpenInterestExpiry");
const brokerProductSelect =
  document.getElementById("brokerProductSelect");
const brokerMarketSelect =
  document.getElementById("brokerMarketSelect");
const brokerTemplate =
    document.getElementById("brokerTemplate");
const directionTemplate =
    document.getElementById("directionTemplate");
const saveAiTemplateButton =
    document.getElementById("saveAiTemplateButton");
const defaultAiTemplates = {
        broker:
            "主要証券会社では買い姿勢が目立つ一方、市場全体では売り姿勢が優勢となっており、市場参加者の見方が分かれています。",
   
        direction:
            "方向感が出るまで、建玉の変化を観察しましょう。"
    };    


nightData.value = localStorage.getItem("optionMapNightData") || "";
dayData.value = localStorage.getItem("optionMapDayData") || "";
optionData.value = localStorage.getItem("optionMapOptionData") || "";
futureOpenInterestData.value =
localStorage.getItem("optionMapFutureOpenInterestData") || "";
let savedAiTemplates = null;

try {
    savedAiTemplates = JSON.parse(
        localStorage.getItem("optionMapAiTemplates")
    );
} catch (error) {
    console.warn(
        "AIコメント設定の読み込みに失敗しました:",
        error
    );
}

const aiTemplates = {
    ...defaultAiTemplates,
    ...(savedAiTemplates || {})
};

brokerTemplate.value = aiTemplates.broker;
directionTemplate.value = aiTemplates.direction;

futureOpenInterestProduct.addEventListener("change", () => {
    updateFutureOpenInterestExpiryOptions(
        futureOpenInterestProduct.value
    );

    drawFutureOpenInterestChart(
        futureOpenInterestProduct.value,
        futureOpenInterestExpiry.value
    );
});
function updateFutureOpenInterestExpiryOptions(productName) {
    if (
        !latestFutureOpenInterestResult ||
        !latestFutureOpenInterestResult.products[productName]
    ) {
        return;
    }

    const productData =
        latestFutureOpenInterestResult.products[productName];

    const expirySet = new Set();

    Object.values(productData.brokers).forEach(position => {
        console.log(position.expiries);
        Object.keys(position.expiries || {}).forEach(expiry => {
            expirySet.add(expiry);
        });
    });

    const expiries = Array.from(expirySet).sort();

    futureOpenInterestExpiry.innerHTML =
        '<option value="all">全限月</option>';

    expiries.forEach(expiry => {
        const option = document.createElement("option");
        option.value = expiry;
        option.textContent = expiry;
        futureOpenInterestExpiry.appendChild(option);
    });
}

futureOpenInterestExpiry.addEventListener("change", () => {
    drawFutureOpenInterestChart(
        futureOpenInterestProduct.value,
        futureOpenInterestExpiry.value
    );
});

const clearInputButton =
    document.getElementById("clearInputButton");
const clearWeeklyButton =
    document.getElementById("clearWeeklyButton");    

if (clearInputButton) {
    clearInputButton.addEventListener("click", () => {
        const shouldClear = confirm(
            "夜間・日中・オプションの入力データを消しますか？"
        );

        if (!shouldClear) {
            return;
        }

        nightData.value = "";
        dayData.value = "";
       
        

        localStorage.removeItem("optionMapNightData");
        localStorage.removeItem("optionMapDayData");
        
        
    });
}

if (clearWeeklyButton) {
    clearWeeklyButton.addEventListener("click", () => {

        const ok = confirm("週次データを消しますか？");

        if (!ok) return;

        optionData.value = "";
        futureOpenInterestData.value = "";

        localStorage.removeItem("optionMapOptionData");
        localStorage.removeItem("optionMapFutureOpenInterestData");

        alert("週次データを削除しました。");
    });
}

nightData.addEventListener("input", () => {
    localStorage.setItem("optionMapNightData", nightData.value);
});

dayData.addEventListener("input", () => {
    localStorage.setItem("optionMapDayData", dayData.value);
});

optionData.addEventListener("input", () => {
    localStorage.setItem("optionMapOptionData", optionData.value);
});

futureOpenInterestData.addEventListener("input", () => {
    localStorage.setItem(
      "optionMapFutureOpenInterestData",
      futureOpenInterestData.value
    );
  });

  brokerProductSelect.addEventListener("change", () => {
    if (latestParsedDayData) {
        updateBrokerChartByProduct(latestParsedDayData);
    } else {
        updateBrokerChartFromSelection();
    }
});
  
brokerMarketSelect.addEventListener("change", () => {
    if (latestParsedDayData) {
        updateBrokerChartByProduct(latestParsedDayData);
    } else {
        updateBrokerChartFromSelection();
    }
});  

const worldMarketImageInput =
    document.getElementById("worldMarketImage");

let worldMarketImageData = "";

if (worldMarketImageInput) {
    worldMarketImageInput.addEventListener("change", function (event) {
        const file = event.target.files[0];

        if (!file) {
            worldMarketImageData = "";
            return;
        }

        const reader = new FileReader();

        reader.onload = function () {
            worldMarketImageData = reader.result;
            console.log("世界の株価画像を読み込みました");
        };

        reader.readAsDataURL(file);
    });
}

button.addEventListener("click", function () {

    
    optionMap = {};

    setTimeout(function () {

        const nightText = nightData.value;
        const dayText = dayData.value;
        const optionText = optionData.value;
        const futureOpenInterestText = futureOpenInterestData.value;
        const nightTotals = analyzeFutureData(nightText);
        const dayTotals = analyzeFutureData(dayText);
        latestNightFutureTotals = nightTotals;
        latestDayFutureTotals = dayTotals;
        const optionResult = analyzeOptionData(optionText);
        const futureOpenInterestResult =
        analyzeFutureOpenInterestData(futureOpenInterestText);
        latestFutureOpenInterestResult = futureOpenInterestResult;
        updateFutureOpenInterestExpiryOptions(
            futureOpenInterestProduct.value
        );

        const aiData = {
            currentPrice: currentPrice,
            nightData: nightData.value,
            dayData: dayData.value,
            optionData: optionData.value,
            
            labels: [...allJpxLabels],
            callOpenInterest: [...allJpxCallValues],
            putOpenInterest: [...allJpxPutValues],
            callVolume: [...allJpxCallVolumes],
            putVolume: [...allJpxPutVolumes],
            futureOpenInterest: futureOpenInterestResult
        };
        
        console.log("AIに渡すデータ:", aiData);
    
        const aiResult = analyzeOptionMapData(aiData);
    
        console.log("ai.jsからの返事:", aiResult);
    

        drawFutureOpenInterestChart(
          document.getElementById("futureOpenInterestProduct").value
        );

        if (latestParsedDayData) {
            updateBrokerChartByProduct(latestParsedDayData);
        } else {
            updateBrokerChartFromSelection();
        }

      console.log(
        "指数先物建玉の解析結果:",
        futureOpenInterestResult
      );

        console.log("optionData文字数:", optionText.length);

        console.log("オプション解析結果:", optionResult);
        
        console.log("価格帯別データ:", optionResult.priceTotals);
        

        if (
            optionResult?.optionMap &&
            Object.keys(optionResult.optionMap).length > 0
        ) {
            optionMap = optionResult.optionMap;
        }
        
        console.log("価格帯マップ:", optionMap);
        
        const optionTotals = optionResult.priceTotals;
        
        const selectedProduct = brokerProductSelect.value;
        const selectedMarket = brokerMarketSelect.value;

        latestNightBrokerData = {
          ...(nightTotals[selectedProduct]?.[selectedMarket] || {})
};

        latestDayBrokerData = {
          ...(dayTotals[selectedProduct]?.[selectedMarket] || {})
};
        latestOptionBrokerData = {
            ...optionResult.brokerTotals};
        const allTotals = {};

        const selectedNightTotals =
        nightTotals[selectedProduct]?.[selectedMarket] || {};

        const selectedDayTotals =
        dayTotals[selectedProduct]?.[selectedMarket] || {};

        for (const company in selectedNightTotals) {
          allTotals[company] = selectedNightTotals[company];
}

        for (const company in selectedDayTotals) {
          if (allTotals[company] === undefined) {
            allTotals[company] = 0;
  }

          allTotals[company] += selectedDayTotals[company];
}

        for (const price in optionTotals) {

            if (allTotals[price] === undefined) {
                allTotals[price] = 0;
            }

            allTotals[price] += optionTotals[price];

        }

        const ranking = Object.entries(allTotals);
        ranking.sort((a, b) => b[1] - a[1]);
        const top10 = ranking.slice(0, 10);

        const labels = [];
        const values = [];

        for (const item of top10) {

            labels.push(companyNames[item[0]] || item[0]);
            values.push(item[1]);

        }

        console.log("① 証券会社別グラフ・開始");
        drawChart(labels, values);
        console.log("② 証券会社別グラフ・完了");

    const priceRanking = Object.entries(optionTotals);
          priceRanking.sort((a, b) => b[1] - a[1]);

    const priceLabels = [];
    const priceValues = [];

for (const item of priceRanking) {
    priceLabels.push(Number(item[0]).toLocaleString() + "円");
    priceValues.push(item[1]);
}



drawOptionTable();

console.log("optionTotals =", optionTotals);
showMaxPosition(optionTotals);



showPriceRanking();

    }, 1000);

});

function showMaxPosition(priceTotals) {
    const result = document.getElementById("maxPosition");

    if (!result) return;

    let maxPrice = "";
    let maxValue = 0;

    for (const price in priceTotals) {
        const value = Number(priceTotals[price]) || 0;

        if (value > maxValue) {
            maxValue = value;
            maxPrice = price;
        }
    }

    result.innerHTML = `
        <p><strong>価格帯</strong></p>
        <h2>${Number(maxPrice || 0).toLocaleString()}円</h2>

        <p><strong>建玉</strong></p>
        <h2>${maxValue.toLocaleString()}枚</h2>
    `;
}

function analyzeFutureData(text) {

    const lines = text.split("\n");

    console.log("analyzeData開始");


    const products = {
        NK225F: {
          auction: {},
          jnet: {},
          combined: {}
        },
        NK225M: {
          auction: {},
          jnet: {},
          combined: {}
        },
        TOPIXF: {
          auction: {},
          jnet: {},
          combined: {}
        }
      };
      
      let currentMarket = "auction";
    

    for (const line of lines) {

        if (line.includes("（J-NET）") || line.includes("(J-NET)")) {
            currentMarket = "jnet";
            console.log("区分を検出: J-NET");
            continue;
          }
          
          if (line.includes("（立会）") || line.includes("(立会)")) {
            currentMarket = "auction";
            console.log("区分を検出: 立会");
            continue;
          }

        const words = line.trim().split(/\s+/);

     if (words.length < 8) continue;

        const company = words.find(word => word.includes("証券"));
        const rawProduct = words.find(word =>
            ["NK225F", "NK225MF", "TOPIXF"].includes(word)
          );
          
          const product =
            rawProduct === "NK225MF"
              ? "NK225M"
              : rawProduct;
        const volume = Number(words[words.length - 1].replace(/,/g, ""));

        console.log(JSON.stringify(line));

       
        if (!line.includes("証券")) continue;

      
        console.log(words);
        console.log(product);
        console.log(company);
        console.log(volume);

        if (!product || !company || isNaN(volume)) continue;

        const marketData = products[product][currentMarket];

        if (!marketData[company]) {
          marketData[company] = 0;
        }
        
        marketData[company] += volume;
        
        if (!products[product].combined[company]) {
          products[product].combined[company] = 0;
        }
        
        products[product].combined[company] += volume;

    }
    console.log("商品別取引高:", products);
    return products;

}



function analyzeOptionData(text) {

    const lines = text.split("\n");

    console.log("analyzeData開始");

    const totals = {};
    const priceTotals = {};

    let currentPrice = "";

    for (const line of lines) {

        console.log(JSON.stringify(line));

        const priceMatch = line.match(/(\d{2},\d{3})\s*円/);

        if (priceMatch) {

            currentPrice = priceMatch[1].replace(",", "");

            console.log("価格帯:", currentPrice);


        }

        if (!line.includes("証券")) continue;

        if (currentPrice === "") {
            console.log("価格が空！", line);
        }

        const words = line.trim().split(/\s+/);

        const company = words.find(word => word.includes("証券"));

        const volumeText = words[words.length - 1];
        const volume = Number(volumeText.replace(/,/g, ""));

        console.log(words);
        console.log(company);
        console.log(volumeText);
        console.log(volume);

        if (!company || isNaN(volume)) continue;

        if (currentPrice === "") {
            console.log("価格が空！！", line);
        }

        if (!totals[company]) {
            totals[company] = 0;
        }

        totals[company] += volume;

        if (!priceTotals[currentPrice]) {
            priceTotals[currentPrice] = 0;
        }

        priceTotals[currentPrice] += volume;

        if (!optionMap[currentPrice]) {
            optionMap[currentPrice] = {};
        }

        if (!optionMap[currentPrice][company]) {
            optionMap[currentPrice][company] = 0;
        }

        optionMap[currentPrice][company] += volume;

    }
    console.log(optionMap);
    return {
        brokerTotals: totals,
        priceTotals: priceTotals,
        optionMap: optionMap
    };

}

function analyzeFutureOpenInterestData(text) {
    console.log("指数先物建玉の解析開始");
  
    const lines = text.split(/\r?\n/);
  
    const products = {};
    let currentProduct = "";
  
    const normalizeText = (value) =>
      String(value || "")
        .replace(/["“”]/g, "")
        .replace(/\u3000/g, " ")
        .replace(/\s+/g, " ")
        .trim();
  
    const toNumber = (value) => {
      const cleaned = String(value || "")
        .replace(/,/g, "")
        .replace(/[^\d.-]/g, "");
  
      const number = Number(cleaned);
      return Number.isFinite(number) ? number : 0;
    };
  
    const normalizeProductName = (value) => {
      const name = normalizeText(value)
        .replace(/[＜<]/g, "")
        .replace(/[＞>]/g, "");
  
      if (name.includes("日経225mini") || name.includes("日経225ミニ")) {
        return "日経225mini";
      }
  
      if (name.includes("日経225先物")) {
        return "日経225先物";
      }
  
      if (name.includes("TOPIX")) {
        return "TOPIX先物";
      }
  
      if (name.includes("JPX日経400")) {
        return "JPX日経400先物";
      }
  
      return name;
    };
  
    const ensureProduct = (productName) => {
      if (!products[productName]) {
        products[productName] = {
          brokers: {},
          sellTotal: 0,
          buyTotal: 0,
        };
      }
  
      return products[productName];
    };
  
    const addBrokerPosition = (
      productName,
      brokerName,
      side,
      volume,
      expiry
    ) => {
      const broker = normalizeText(brokerName);
  
      if (!productName || !broker || volume <= 0) {
        return;
      }
  
      const product = ensureProduct(productName);
  
      if (!product.brokers[broker]) {
        product.brokers[broker] = {
          sell: 0,
          buy: 0,
          net: 0,
          expiries: {},
        };
      }
  
      const brokerData = product.brokers[broker];
  
      brokerData[side] += volume;
  
      if (side === "sell") {
        product.sellTotal += volume;
      } else {
        product.buyTotal += volume;
      }
  
      console.log(productName, expiry);
      if (expiry) {
        if (!brokerData.expiries[expiry]) {
          brokerData.expiries[expiry] = {
            sell: 0,
            buy: 0,
            net: 0,
          };
        }
  
        brokerData.expiries[expiry][side] += volume;
  
        brokerData.expiries[expiry].net =
          brokerData.expiries[expiry].buy -
          brokerData.expiries[expiry].sell;
      }
  
      brokerData.net = brokerData.buy - brokerData.sell;

      console.log({
        broker,
        side,
        sell: brokerData.sell,
        buy: brokerData.buy,
        net: brokerData.net,
        expiry
    });
    };
  
    for (const rawLine of lines) {
      const line = rawLine.trim();
  
      if (!line) {
        continue;
      }
  
      // ＜日経225先物＞などの商品見出し
      const productMatch = line.match(/[＜<]([^＞>]+)[＞>]/);
  
      if (productMatch) {
        currentProduct = normalizeProductName(productMatch[1]);
        ensureProduct(currentProduct);
  
        console.log("商品を検出:", currentProduct);
        continue;
      }
  
      if (!currentProduct) {
        continue;
      }
  
      // Excelから貼り付けたタブ区切りを維持
      const cells = rawLine.split("\t").map(normalizeText);

console.log(
    "週次建玉行:",
    currentProduct,
    cells
);


  
      // 順位で始まらない行は、見出しなどとして除外
      if (!/^\d+$/.test(cells[0] || "")) {
        continue;
      }
  
      /*
        想定される列：
        0 順位
        1 売り側の限月
        2 売り建玉
        3 売り参加者
        4 買い建玉
        5 買い側の限月
        6 買い参加者
      */
  
        const expiryPattern = /^20\d{2}年\d{1,2}月限月$/;

        cells.forEach((cell, expiryIndex) => {
            const expiry = cell || "";
        
            if (!expiryPattern.test(expiry)) {
                return;
            }
        
            const sellVolume = toNumber(cells[expiryIndex + 1]);
            const sellBroker = cells[expiryIndex + 2] || "";
        
            const buyVolume = toNumber(cells[expiryIndex + 3]);
            const buyBroker = cells[expiryIndex + 5] || "";
        
            addBrokerPosition(
                currentProduct,
                sellBroker,
                "sell",
                sellVolume,
                expiry
            );
        
            addBrokerPosition(
                currentProduct,
                buyBroker,
                "buy",
                buyVolume,
                expiry
            );
        });
  
    }

    // 全商品を合算した証券会社別データ
    const brokerTotals = {};
  
    for (const productData of Object.values(products)) {
      for (const [broker, position] of Object.entries(productData.brokers)) {
        if (!brokerTotals[broker]) {
          brokerTotals[broker] = {
            sell: 0,
            buy: 0,
            net: 0,
          };
        }
  
        brokerTotals[broker].sell += position.sell;
        brokerTotals[broker].buy += position.buy;
        brokerTotals[broker].net =
          brokerTotals[broker].buy -
          brokerTotals[broker].sell;
      }
    }
  
    console.log("指数先物建玉・商品別:", products);
    console.log("指数先物建玉・証券会社別合計:", brokerTotals);
  
    return {
      products,
      brokerTotals,
    };
  }

  function analyzeFutureOpenInterestJson(rows) {
    console.log("週次先物JSON解析開始");

    const products = {};
    const brokerTotals = {};

    const normalizeText = value =>
        String(value ?? "")
            .replace(/\r?\n/g, "")
            .replace(/\u3000/g, "")
            .replace(/\s+/g, "")
            .trim();

    const toNumber = value => {
        const cleaned = String(value ?? "")
            .replace(/,/g, "")
            .replace(/[^\d.-]/g, "");

        const number = Number(cleaned);
        return Number.isFinite(number) ? number : 0;
    };

    const ensureProduct = productName => {
        if (!products[productName]) {
            products[productName] = {
                brokers: {},
                sellTotal: 0,
                buyTotal: 0,
            };
        }

        return products[productName];
    };

    const addBrokerPosition = (
        productName,
        brokerName,
        side,
        volume,
        expiry
    ) => {
        const broker = normalizeText(brokerName);
        const amount = toNumber(volume);

        if (!productName || !broker || amount <= 0) {
            return;
        }

        const product = ensureProduct(productName);

        if (!product.brokers[broker]) {
            product.brokers[broker] = {
                sell: 0,
                buy: 0,
                net: 0,
                expiries: {},
            };
        }

        const brokerData = product.brokers[broker];

        brokerData[side] += amount;

        if (side === "sell") {
            product.sellTotal += amount;
        } else {
            product.buyTotal += amount;
        }

        if (expiry) {
            if (!brokerData.expiries[expiry]) {
                brokerData.expiries[expiry] = {
                    sell: 0,
                    buy: 0,
                    net: 0,
                };
            }

            brokerData.expiries[expiry][side] += amount;

            brokerData.expiries[expiry].net =
                brokerData.expiries[expiry].buy -
                brokerData.expiries[expiry].sell;
        }

        brokerData.net = brokerData.buy - brokerData.sell;
    };

    let currentProduct = "";

    const expiryPattern = /^20\d{2}年\d{1,2}月限月$/;

    for (const row of rows) {
        if (!Array.isArray(row)) continue;

        const firstCell = normalizeText(row[0]);

        if (firstCell.includes("日経225mini")) {
            currentProduct = "日経225mini";
            ensureProduct(currentProduct);
            console.log("商品を検出:", currentProduct);
            continue;
        }

        if (firstCell.includes("日経225先物")) {
            currentProduct = "日経225先物";
            ensureProduct(currentProduct);
            console.log("商品を検出:", currentProduct);
            continue;
        }

        if (firstCell.includes("TOPIX")) {
            currentProduct = "TOPIX先物";
            ensureProduct(currentProduct);
            console.log("商品を検出:", currentProduct);
            continue;
        }

        if (!currentProduct) continue;

        row.forEach((cell, expiryIndex) => {
            const expiry = normalizeText(cell);

            if (!expiryPattern.test(expiry)) {
                return;
            }

            const sellVolume = toNumber(row[expiryIndex + 1]);
            const sellBroker = row[expiryIndex + 2] ?? "";

            const buyVolume = toNumber(row[expiryIndex + 3]);
            const buyBroker = row[expiryIndex + 5] ?? "";

            addBrokerPosition(
                currentProduct,
                sellBroker,
                "sell",
                sellVolume,
                expiry
            );

            addBrokerPosition(
                currentProduct,
                buyBroker,
                "buy",
                buyVolume,
                expiry
            );
        });
    }

    for (const productData of Object.values(products)) {
        for (const [broker, position] of Object.entries(
            productData.brokers
        )) {
            if (!brokerTotals[broker]) {
                brokerTotals[broker] = {
                    sell: 0,
                    buy: 0,
                    net: 0,
                };
            }

            brokerTotals[broker].sell += position.sell;
            brokerTotals[broker].buy += position.buy;
            brokerTotals[broker].net =
                brokerTotals[broker].buy -
                brokerTotals[broker].sell;
        }
    }

    console.log("週次先物・商品別:", products);
    console.log("週次先物・証券会社別合計:", brokerTotals);

    return {
        products,
        brokerTotals,
    };
}

function analyzeOptionOpenInterestJson(rows) {
    console.log("週次オプションJSON解析開始");

    const optionMapResult = {};
    const priceTotals = {};
    const brokerTotals = {};

    const addPosition = (price, broker, volume) => {
        price = Number(price);
        volume = Number(volume);

        if (!Number.isFinite(price) || price <= 0) return;
        if (!broker || !Number.isFinite(volume) || volume <= 0) return;

        // 既存の companyNames を使って略称へ統一
        const brokerKey = companyNames[broker] || broker;

        if (!optionMapResult[price]) {
            optionMapResult[price] = {};
        }

        if (!optionMapResult[price][brokerKey]) {
            optionMapResult[price][brokerKey] = 0;
        }

        optionMapResult[price][brokerKey] += volume;

        if (!priceTotals[price]) {
            priceTotals[price] = 0;
        }

        priceTotals[price] += volume;

        if (!brokerTotals[brokerKey]) {
            brokerTotals[brokerKey] = 0;
        }

        brokerTotals[brokerKey] += volume;
    };

    for (const row of rows) {
        if (!Array.isArray(row)) continue;

        // PUT
        addPosition(row[1], row[3], row[4]);
        addPosition(row[1], row[6], row[7]);

        // CALL
        addPosition(row[11], row[13], row[14]);
        addPosition(row[11], row[16], row[17]);
    }

    console.log("週次オプション optionMap:", optionMapResult);
    console.log("週次オプション priceTotals:", priceTotals);
    console.log("週次オプション brokerTotals:", brokerTotals);

    return {
        optionMap: optionMapResult,
        priceTotals,
        brokerTotals,
    };
}

function drawChart(labels, values) {
    latestBrokerLabels = [...labels];
    latestBrokerValues = [...values];

    const ctx = document.getElementById("myChart");

    if (!ctx) {
        console.error("myChartのcanvasが見つかりません");
        return;
    }

    const existingChart = Chart.getChart(ctx);

    if (existingChart) {
        existingChart.destroy();
    }

    myChart = new Chart(ctx, {
        type: "bar",
        data: {
            labels: labels,
            datasets: [{
                label: "取引枚数",
                data: values,
            
                backgroundColor: values.map(value => {
                    if (value >= 50000) return "#ff4d4d";   // 赤
                    if (value >= 30000)  return "#ff9933";   // オレンジ
                    if (value >= 10000)  return "#ffd966";   // 黄色
                    return "#b6d7a8";                      // 緑
                }),
            
                borderColor: "#2f6fb6",
                borderWidth: 1,
            
                barPercentage: 0.95,
                categoryPercentage: 0.9
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
          
            interaction: {
              mode: "index",
              intersect: false
            },
          
            plugins: {
              tooltip: {
                enabled: true,
                callbacks: {
                  label: (context) => {
                    const value = Number(context.raw || 0);
                    return `取引枚数: ${value.toLocaleString("ja-JP")}枚`;
                  }
                }
              }
            }
          }
    });

}

function drawPriceChart(labels, values) {

    const ctx = document.getElementById("priceChart");

    if (!ctx) {
        console.error("priceChartのcanvasが見つかりません");
        return;
    }
    
    const existingChart = Chart.getChart(ctx);
    
    if (existingChart) {
        existingChart.destroy();
    }
    priceChart = new Chart(ctx, {
        type: "bar",
        data: {
            labels: labels,
            datasets: [{
                label: "価格帯建玉",
                data: values,

                backgroundColor: values.map(value => {

                    if (value >= 3000) return "#ff4d4d";   // 赤
                    if (value >= 500)  return "#ff9933";   // オレンジ
                    if (value >= 100)  return "#ffd966";   // 黄色

                    return "#b6d7a8";                      // 緑
                }),

                borderColor: "#2f6fb6",
                borderWidth: 1,

                barPercentage: 0.95,
                categoryPercentage: 0.9

            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false
        }
    });


}

function drawFutureOpenInterestChart(
    productName,
    selectedExpiry = "all"
) {
 
    console.log(
        "週次商品キー一覧:",
        Object.keys(latestFutureOpenInterestResult.products || {})
    );
    
    console.log(
        "選択中の商品名:",
        productName
    );

    const productData =
      latestFutureOpenInterestResult.products[productName];
  
    if (!productData) {
      console.warn("指数先物建玉の商品データがありません:", productName);
      return;
    }
  
    const allRows = Object.entries(productData.brokers)
    .map(([broker, position]) => {
        const source =
            selectedExpiry === "all"
                ? position
                : position.expiries?.[selectedExpiry];

        return {
            broker,
            sell: source?.sell || 0,
            buy: source?.buy || 0,
        };
    });

const topBuyRows = [...allRows]
    .filter(row => row.buy > 0)
    .sort((a, b) => b.buy - a.buy)
    .slice(0, 5);

const topSellRows = [...allRows]
    .filter(row => row.sell > 0)
    .sort((a, b) => b.sell - a.sell)
    .slice(0, 5);

const rowMap = new Map();

[...topBuyRows, ...topSellRows].forEach(row => {
    rowMap.set(row.broker, row);
});

const rows = Array.from(rowMap.values());
    const labels = rows.map((row) => companyNames[row.broker] || row.broker);
    const sellValues = rows.map((row) => row.sell);
    const buyValues = rows.map((row) => row.buy);
  
    const canvas = document.getElementById("futureOpenInterestChart");
  
    if (!canvas) {
      console.error("futureOpenInterestChart が見つかりません");
      return;
    }
  
    const existingChart = Chart.getChart(canvas);
  
    if (existingChart) {
      existingChart.destroy();
    }
  
    futureOpenInterestChart = new Chart(canvas, {
      type: "bar",
      data: {
        labels,
        datasets: [
          {
            label: "売り建玉",
            data: sellValues,
            backgroundColor: "rgba(255, 99, 132, 0.75)",
            borderColor: "rgba(255, 99, 132, 1)",
            borderWidth: 1,
            categoryPercentage: 0.8,
            barPercentage: 0.9,
          },
          {
            label: "買い建玉",
            data: buyValues,
            backgroundColor: "rgba(54, 162, 235, 0.75)",
            borderColor: "rgba(54, 162, 235, 1)",
            borderWidth: 1,
            categoryPercentage: 0.8,
            barPercentage: 0.9,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
  
        interaction: {
          mode: "index",
          intersect: false,
        },
  
        scales: {
          x: {
            stacked: false,
            offset: true,
            ticks: {
              maxRotation: 45,
              minRotation: 0,
            },
          },
  
          y: {
            beginAtZero: true,
            ticks: {
              callback: (value) => Number(value).toLocaleString("ja-JP"),
            },
            title: {
              display: true,
              text: "建玉枚数",
            },
          },
        },
  
        plugins: {
          tooltip: {
            callbacks: {
              label: (context) => {
                const value = Number(context.raw || 0).toLocaleString("ja-JP");
                return `${context.dataset.label}: ${value}枚`;
              },
            },
          },
        },
      },
    });
  

    
    const ranking = document.getElementById("futureOpenInterestRanking");

    const buyRanking = [...rows]
       .filter(r => r.buy > 0)
       .sort((a,b)=>b.buy-a.buy)
       .slice(0,5);
    
    const sellRanking = [...rows]
        .filter(r => r.sell > 0)
        .sort((a,b)=>b.sell-a.sell)
        .slice(0,5);
    
    ranking.innerHTML = `
    <div class="ranking-columns">
    
    <div>
    <h3>📈 買い建玉 TOP5</h3>
    <ol>
    ${buyRanking.map(r=>`
    <li>${companyNames[r.broker] || r.broker}
    （${r.buy.toLocaleString()}枚）
    </li>`).join("")}
    </ol>
    </div>
    
    <div>
    <h3>📉 売り建玉 TOP5</h3>
    <ol>
    ${sellRanking.map(r=>`
    <li>${companyNames[r.broker] || r.broker}
    （${r.sell.toLocaleString()}枚）
    </li>`).join("")}
    </ol>
    </div>
    
    </div>
    `;

    console.log("指数先物建玉グラフ作成成功:", productName);
  }


  function updateBrokerChartFromSelection() {

    console.log("★ broker初回描画");
    console.log("★ latestNightFutureTotals =", latestNightFutureTotals);
    console.log("★ latestDayFutureTotals =", latestDayFutureTotals);

    if (!latestNightFutureTotals || !latestDayFutureTotals) {
      return;
    }
  
    const selectedProduct = brokerProductSelect.value;
    const selectedMarket = brokerMarketSelect.value;
  
    const selectedNightTotals =
      latestNightFutureTotals[selectedProduct]?.[selectedMarket] || {};
  
    const selectedDayTotals =
      latestDayFutureTotals[selectedProduct]?.[selectedMarket] || {};
  
      console.log("★ selectedProduct =", selectedProduct);
      console.log("★ selectedMarket =", selectedMarket);
      console.log("★ selectedNightTotals =", selectedNightTotals);
      console.log("★ selectedDayTotals =", selectedDayTotals);

      console.log(
        "★ night NK225Fの区分キー =",
        Object.keys(latestNightFutureTotals[selectedProduct] || {})
    );
    
    console.log(
        "★ day NK225Fの区分キー =",
        Object.keys(latestDayFutureTotals[selectedProduct] || {})
    );

    latestNightBrokerData = { ...selectedNightTotals };
    latestDayBrokerData = { ...selectedDayTotals };
  
    const combinedBrokerTotals = {};
  
    for (const company in selectedNightTotals) {
      combinedBrokerTotals[company] = selectedNightTotals[company];
    }
  
    for (const company in selectedDayTotals) {
      if (combinedBrokerTotals[company] === undefined) {
        combinedBrokerTotals[company] = 0;
      }
  
      combinedBrokerTotals[company] += selectedDayTotals[company];
    }
  
    const sortedEntries = Object.entries(combinedBrokerTotals)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);
  
    const labels = sortedEntries.map(
      ([company]) => companyNames[company] || company
    );
  
    const values = sortedEntries.map(([, volume]) => volume);
  
    drawChart(labels, values);
  
    console.log("証券会社別グラフを切替:", {
      selectedProduct,
      selectedMarket,
      combinedBrokerTotals
    });
  }

  function updateBrokerChartFromExcel(records) {
    if (!Array.isArray(records) || records.length === 0) {
        console.warn("Excel由来の証券会社データがありません");
        return;
    }

    const top10 = [...records]
        .sort((a, b) => b.volume - a.volume)
        .slice(0, 10);

    const labels = top10.map(item => item.company);
    const values = top10.map(item => item.volume);

    console.log("Excelデータから証券会社グラフを更新:", top10);

    drawChart(labels, values);
}

function mergeBrokerRecords(auctionRecords, jnetRecords) {
    const map = new Map();

    function add(records) {
        if (!Array.isArray(records)) return;

        for (const item of records) {
            const key = item.company;

            if (!map.has(key)) {
                map.set(key, {
                    ...item,
                    volume: 0
                });
            }

            map.get(key).volume += item.volume;
        }
    }

    add(auctionRecords);
    add(jnetRecords);

    return [...map.values()];
}

function updateBrokerChartByProduct(parsedDayData) {
    const product = brokerProductSelect.value;
    const market = brokerMarketSelect.value;

    const getProductRecords = data => {
        if (!data) return [];

        if (product === "NK225F") {
            return data.large?.records || [];
        }

        if (product === "NK225M") {
            return data.mini?.records || [];
        }

        if (product === "TOPIXF") {
            return data.topix?.records || [];
        }

        if (product === "NK225E") {
            return data.micro?.records || [];
        }

        console.warn("未対応の商品です:", product);
        return [];
    };

    const dayAuctionRecords = getProductRecords(
        parsedDayData.dayAuction
    );

    const dayJnetRecords = getProductRecords(
        parsedDayData.dayJnet
    );

    const nightAuctionRecords = getProductRecords(
        parsedDayData.nightAuction
    );

    const nightJnetRecords = getProductRecords(
        parsedDayData.nightJnet
    );

    let records = [];

    if (market === "auction") {
        records = mergeBrokerRecords(
            dayAuctionRecords,
            nightAuctionRecords
        );
    } else if (market === "jnet") {
        records = mergeBrokerRecords(
            dayJnetRecords,
            nightJnetRecords
        );

    } else if (market === "combined") {
        const auctionRecords = mergeBrokerRecords(
            dayAuctionRecords,
            nightAuctionRecords
        );

        const jnetRecords = mergeBrokerRecords(
            dayJnetRecords,
            nightJnetRecords
        );

        records = mergeBrokerRecords(
            auctionRecords,
            jnetRecords
        );
    }

    updateBrokerChartFromExcel(records);
}

function setLatestParsedDayData(data) {
    latestParsedDayData = data;

    if (latestParsedDayData) {
        updateBrokerChartByProduct(latestParsedDayData);
    
        console.log(

            "🔵 自動取得 parsedDayData =",

            latestParsedDayData

        );

    }
}

window.setLatestParsedDayData = setLatestParsedDayData;

function createBarColors(values, normalColor, strongColor) {

    const positiveValues = values
        .filter(value => value > 0)
        .sort((a, b) => b - a);

    const thirdLargest = positiveValues[2] || positiveValues[0] || 0;

    return values.map((value, index) => {

        // 建玉上位3か所
        if (value >= thirdLargest && value > 0) {
            return strongColor;
        }

        const isEdge = index === 0 || index === values.length - 1;

        const previous = values[index - 1] || 0;
        const next = values[index + 1] || 0;
        const nearbyAverage = (previous + next) / 2;
        
        // 前後平均より50%以上大きい価格帯
        if (
            !isEdge &&
            value > 0 &&
            nearbyAverage > 0 &&
            value >= nearbyAverage * 1.5
        ) {
            return "rgba(255, 165, 0, 0.95)";
        }

        return normalColor;
    });
}



const currentPriceLinePlugin = {
    id: "currentPriceLine",

    afterDatasetsDraw(chart) {

        const labels = chart.data.labels;

        let priceIndex = -1;
let smallestDifference = Infinity;

labels.forEach((label, index) => {

    const strike =
        Number(String(label).replace(/,/g, ""));

    const difference =
        Math.abs(strike - currentPrice);

    if (difference < smallestDifference) {
        smallestDifference = difference;
        priceIndex = index;
    }
});
        if (priceIndex === -1) {
            return;
        }

        const xScale = chart.scales.x;
        const yScale = chart.scales.y;
        const x = xScale.getPixelForValue(priceIndex);
        const nearestStrike =
    Number(
        String(labels[priceIndex]).replace(/,/g, "")
    );

        const ctx = chart.ctx;

        ctx.save();

        ctx.beginPath();
        ctx.moveTo(x, yScale.top);
        ctx.lineTo(x, yScale.bottom);

        ctx.lineWidth = 3;
        ctx.strokeStyle = "rgba(0, 0, 0, 0.8)";
        ctx.setLineDash([6, 4]);
        ctx.stroke();

        ctx.setLineDash([]);
        ctx.fillStyle = "rgba(0, 0, 0, 0.85)";
        ctx.font = "bold 13px sans-serif";
        ctx.textAlign = "center";

        ctx.fillText(
            "現在値 " + currentPrice.toLocaleString() + "円",
            x,
            yScale.top + 16
        );
        
        ctx.font = "12px sans-serif";
        
        ctx.fillText(
            "最寄り " + nearestStrike.toLocaleString() + "円",
            x,
            yScale.top + 34
        );

        ctx.restore();
    }
};

const currentPriceInput =
    document.getElementById("currentPriceInput");

const updateCurrentPriceButton =
    document.getElementById("updateCurrentPriceButton");

const currentPriceStatus =
    document.getElementById("currentPriceStatus");

const priceSource =
    document.getElementById("priceSource");


// 保存してある現在値を読み込む
const savedPrice =
    localStorage.getItem("optionMapCurrentPrice");

const savedSource =
    localStorage.getItem("optionMapPriceSource");

if (savedPrice) {

    const restoredPrice = Number(savedPrice);

    if (Number.isFinite(restoredPrice) && restoredPrice > 0) {

        currentPrice = restoredPrice;

        if (currentPriceInput) {
            currentPriceInput.value = restoredPrice;
        }

        if (currentPriceStatus) {
            currentPriceStatus.textContent =
                "現在値：" +
                restoredPrice.toLocaleString() +
                "円";
        }
    }
}

if (savedSource && priceSource) {
    priceSource.value = savedSource;
}


// 「現在値を反映」ボタン
if (updateCurrentPriceButton && currentPriceInput) {

    updateCurrentPriceButton.addEventListener("click", function () {

        const newPrice = Number(currentPriceInput.value);

        if (!Number.isFinite(newPrice) || newPrice <= 0) {
            alert("正しい現在値を入力してください");
            return;
        }

        currentPrice = newPrice;

        localStorage.setItem(
            "optionMapCurrentPrice",
            String(currentPrice)
        );

        if (priceSource) {
            localStorage.setItem(
                "optionMapPriceSource",
                priceSource.value
            );
        }

        if (currentPriceStatus) {
            currentPriceStatus.textContent =
                "現在値：" +
                currentPrice.toLocaleString() +
                "円";
        }

        if (allJpxLabels.length > 0) {
            window.drawJpxPriceChart(
                allJpxLabels,
                allJpxCallValues,
                allJpxPutValues,
                allJpxCallVolumes,
                allJpxPutVolumes
            );
        }

        

        console.log("現在値を変更:", currentPrice);
    });
}
function updateWallCandidates(labels, callValues, putValues) {

    const callWallResult =
        document.getElementById("callWallResult");

    const putWallResult =
        document.getElementById("putWallResult");

    const callCandidates = [];
    const putCandidates = [];

    labels.forEach((label, index) => {

        const strike =
            Number(String(label).replace(/,/g, ""));

        const callValue =
            Number(callValues[index]) || 0;

        const putValue =
            Number(putValues[index]) || 0;

        // 現在値より上のCALL候補
        if (strike > currentPrice && callValue > 0) {
            callCandidates.push({
                strike: strike,
                value: callValue
            });
        }

        // 現在値より下のPUT候補
        if (strike < currentPrice && putValue > 0) {
            putCandidates.push({
                strike: strike,
                value: putValue
            });
        }
    });

    // 建玉が多い順
    callCandidates.sort((a, b) => b.value - a.value);
    putCandidates.sort((a, b) => b.value - a.value);

    const topCallWalls = callCandidates.slice(0, 3);
    const topPutWalls = putCandidates.slice(0, 3);

    if (callWallResult) {

        if (topCallWalls.length === 0) {
            callWallResult.textContent =
                "候補が見つかりません";
        } else {
            callWallResult.innerHTML =
                topCallWalls
                    .map((item, index) =>
                        `${index + 1}位　` +
                        `${item.strike.toLocaleString()}円・` +
                        `${item.value.toLocaleString()}枚`
                    )
                    .join("<br>");
        }
    }

    if (putWallResult) {

        if (topPutWalls.length === 0) {
            putWallResult.textContent =
                "候補が見つかりません";
        } else {
            putWallResult.innerHTML =
                topPutWalls
                    .map((item, index) =>
                        `${index + 1}位　` +
                        `${item.strike.toLocaleString()}円・` +
                        `${item.value.toLocaleString()}枚`
                    )
                    .join("<br>");
        }
    }
}



const combinedWallRankPlugin = {
    id: "combinedWallRankPlugin",

    afterDatasetsDraw(chart) {

        const labels = chart.data.labels;
        const ctx = chart.ctx;

        ctx.save();

        chart.data.datasets.forEach((dataset, datasetIndex) => {

            const candidates = [];

            labels.forEach((label, index) => {

                const strike =
                    Number(String(label).replace(/,/g, ""));

                const value =
                    Math.abs(Number(dataset.data[index]) || 0);

                const isCallCandidate =
                    datasetIndex === 0 &&
                    strike > currentPrice;

                const isPutCandidate =
                    datasetIndex === 1 &&
                    strike < currentPrice;

                if (
                    value > 0 &&
                    (isCallCandidate || isPutCandidate)
                ) {
                    candidates.push({
                        index: index,
                        value: value
                    });
                }
            });

            candidates.sort((a, b) => b.value - a.value);

            const topThree = candidates.slice(0, 3);
            const meta = chart.getDatasetMeta(datasetIndex);

            topThree.forEach((item, rankIndex) => {

                const bar = meta.data[item.index];

                if (!bar) return;

                const x = bar.x;

                let y;

                if (datasetIndex === 0) {
                    // CALLは棒の上
                    y = Math.max(
                        chart.chartArea.top + 13,
                        bar.y - 14
                    );
                } else {
                    // PUTは棒の下
                    y = Math.min(
                        chart.chartArea.bottom - 13,
                        bar.y + 14 + rankIndex * 25
                    );
                }

                ctx.beginPath();
                ctx.arc(x, y, 11, 0, Math.PI * 2);

                ctx.fillStyle =
                    datasetIndex === 0
                        ? "rgba(0, 82, 204, 0.95)"
                        : "rgba(220, 20, 60, 0.95)";

                ctx.fill();

                ctx.fillStyle = "#ffffff";
                ctx.font = "bold 12px sans-serif";
                ctx.textAlign = "center";
                ctx.textBaseline = "middle";

                ctx.fillText(
                    String(rankIndex + 1),
                    x,
                    y
                );
            });
        });

        ctx.restore();
    }
};

function updateMarketInfo(startStrike, endStrike) {

    const priceElement =
        document.getElementById("marketCurrentPrice");

    const rangeElement =
        document.getElementById("marketDisplayRange");

    const fetchedAtElement =
        document.getElementById("marketFetchedAt");

    if (priceElement) {
        priceElement.textContent =
            currentPrice.toLocaleString() + "円";
    }

    if (rangeElement) {
        rangeElement.textContent =
            startStrike.toLocaleString() +
            "円 ～ " +
            endStrike.toLocaleString() +
            "円";
    }

    if (fetchedAtElement && lastJpxFetchedAt) {
        fetchedAtElement.textContent =
            lastJpxFetchedAt.toLocaleString(
                "ja-JP",
                {
                    year: "numeric",
                    month: "numeric",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit"
                }
            );
    }
}

window.setJpxSourceTime = function (date) {

    if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
        console.error("JPX元データ日時が正しくありません");
        return;
    }

    lastJpxFetchedAt = date;

    const fetchedAtElement =
        document.getElementById("marketFetchedAt");

    if (fetchedAtElement) {
        fetchedAtElement.textContent =
            lastJpxFetchedAt.toLocaleString("ja-JP", {
                month: "numeric",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit"
            });
    }

    console.log("JPX元データ日時:", lastJpxFetchedAt);
};

const showOpenInterestButton =
    document.getElementById(
        "showOpenInterestButton"
    );

const showVolumeButton =
    document.getElementById(
        "showVolumeButton"
    );

function switchChartMode(mode) {

    currentChartMode = mode;

    if (showOpenInterestButton) {
        showOpenInterestButton.classList.toggle(
            "active",
            mode === "openInterest"
        );
    }

    if (showVolumeButton) {
        showVolumeButton.classList.toggle(
            "active",
            mode === "volume"
        );
    }

    if (allJpxLabels.length > 0) {
        window.drawJpxPriceChart(
            allJpxLabels,
            allJpxCallValues,
            allJpxPutValues,
            allJpxCallVolumes,
            allJpxPutVolumes
        );
    }
}

if (showOpenInterestButton) {
    showOpenInterestButton.addEventListener(
        "click",
        function () {
            switchChartMode("openInterest");
        }
    );
}

if (showVolumeButton) {
    showVolumeButton.addEventListener(
        "click",
        function () {
            switchChartMode("volume");
        }
    );
}

const saveJpxSnapshotButton =
    document.getElementById("saveJpxSnapshotButton");

const snapshotSaveStatus =
    document.getElementById("snapshotSaveStatus");

    const savedSnapshotList =
    document.getElementById("savedSnapshotList");

    function updateIntelligenceCard(savedSnapshots) {

        const snapshotCountElement =
            document.getElementById(
                "intelligenceSnapshotCount"
            );
    
        const dayCountElement =
            document.getElementById(
                "intelligenceDayCount"
            );
    
        const levelElement =
            document.getElementById(
                "intelligenceLevel"
            );
    
        const starsElement =
            document.getElementById(
                "intelligenceStars"
            );
    
        const messageElement =
            document.getElementById(
                "intelligenceMessage"
            );
    
        const progressBar =
            document.getElementById("intelligenceProgressBar");
        
        const progressText =
            document.getElementById("intelligenceProgressText");

        const validSnapshots =
            Array.isArray(savedSnapshots)
                ? savedSnapshots
                : [];
    
        const uniqueDays = new Set();
    
        validSnapshots.forEach(snapshot => {
    
            const date =
                new Date(snapshot.sourceDate);
    
            if (Number.isNaN(date.getTime())) {
                return;
            }
    
            const dayKey = [
                date.getFullYear(),
                String(date.getMonth() + 1)
                    .padStart(2, "0"),
                String(date.getDate())
                    .padStart(2, "0")
            ].join("-");
    
            uniqueDays.add(dayKey);
        });
    
        const snapshotCount =
            validSnapshots.length;
    
        const dayCount =
            uniqueDays.size;
        
        let level = 1;
        let starCount = 1;
        let message =
            "データの蓄積を始めたばかりです。";
            let nextLevelDays = 7;
        if (dayCount >= 180) {
            confidence = "★★★★★";
            level = 5;
            starCount = 5;
            nextLevelDays = 0;

            message =
                "長期分析に使えるデータが十分に蓄積されています。";
        } else if (dayCount >= 90) {
            confidence = "★★★★★";
            level = 4;
            starCount = 4;
            nextLevelDays = 180;

            message =
                "季節やSQ前後の傾向を調べられる量になってきました。";
        } else if (dayCount >= 30) {
            confidence = "★★★★★";
            level = 3;
            starCount = 3;
            nextLevelDays = 90;

            message =
                "月単位の変化や繰り返しを確認できる段階です。";
        } else if (dayCount >= 7) {
            confidence = "★★☆☆☆";
            level = 2;
            starCount = 2;
            nextLevelDays = 30;

            message =
                "短期的な建玉変化を比較できる量になってきました。";
        }
    
        const progressPercent =
        nextLevelDays > 0
            ? Math.min((dayCount / nextLevelDays) * 100, 100)
            : 100;
    
    if (progressBar) {
        progressBar.style.width = `${progressPercent}%`;
    }
    
    if (progressText) {
        progressText.textContent =
            nextLevelDays > 0
                ? `${dayCount}日 / ${nextLevelDays}日`
                : `${dayCount}日 / MAX`;
    }

        const stars =
            "★".repeat(starCount) +
            "☆".repeat(5 - starCount);
    
        if (snapshotCountElement) {
            snapshotCountElement.textContent =
                snapshotCount.toLocaleString() +
                "件";
        }
    
        if (dayCountElement) {
            dayCountElement.textContent =
                dayCount.toLocaleString() +
                "日";
        }
    
        if (levelElement) {
            levelElement.textContent =
                "Lv." + level;
        }
    
        if (starsElement) {
            starsElement.textContent =
                stars;
        }
    
        if (messageElement) {

            if (nextLevelDays === 0) {
        
                messageElement.textContent =
                    "🎉 Intelligence MAX Lv に到達しました！";
        
            }
            else {
        
                const remain =
                    nextLevelDays - dayCount;
        
                messageElement.textContent =
                    message +
                    "　次のレベルまであと " +
                    remain +
                    " 日";
        
            }
        
        }
    }

function renderSavedSnapshots() {

    if (!savedSnapshotList) {
        return;
    }

    const storageKey = "optionMapJpxSnapshots";

    let savedSnapshots = [];

    try {
        savedSnapshots = JSON.parse(
            localStorage.getItem(storageKey) || "[]"
        );

        const weeklySnapshots = savedSnapshots
        .filter(snapshot => snapshot?.futureOpenInterest)
        .map(snapshot => ({
            date: snapshot.sourceDate.slice(0, 10),
            futureOpenInterest: snapshot.futureOpenInterest
        }));
    
    console.log(
        "📚 保存済み週次建玉一覧 =",
        weeklySnapshots
    );

    const weeklyCheck = weeklySnapshots.map(item => {
        const nikkei225 =
            item.futureOpenInterest?.products?.["日経225先物"];
    
        return {
            date: item.date,
            sellTotal: nikkei225?.sellTotal ?? null,
            buyTotal: nikkei225?.buyTotal ?? null
        };
    });
    
    console.log(
        "🔍 週次建玉内容確認 =",
        weeklyCheck
    );
    
    const uniqueWeeklySnapshots = [];

    let previousSignature = null;
    
    weeklySnapshots.forEach(item => {
        const signature =
            JSON.stringify(item.futureOpenInterest);
    
        if (signature !== previousSignature) {
            uniqueWeeklySnapshots.push(item);
            previousSignature = signature;
        }
    });
    
    console.log(
        "✨ 重複除外した週次建玉 =",
        uniqueWeeklySnapshots.map(item => ({
            date: item.date,
            sellTotal:
                item.futureOpenInterest
                    ?.products?.["日経225先物"]
                    ?.sellTotal ?? null,
            buyTotal:
                item.futureOpenInterest
                    ?.products?.["日経225先物"]
                    ?.buyTotal ?? null
        }))
    );

    let weeklyBrokerDiffs = {};
    let weeklyBrokerHistory = [];

    const weeklyBrokerCommentElement =
        document.getElementById("weeklyBrokerComment");

    if (weeklyBrokerCommentElement) {
        weeklyBrokerCommentElement.textContent =
            "比較できる週次データが不足しています。";
    }

    const brokerMap = {
        JPM: "ＪＰモルガン証券",
        GS: "ゴールドマン証券",
        NOMURA: "野村証券",
        BNP: "ＢＮＰパリバ証券",
        ABN: "ＡＢＮクリアリン証券"
    };
    
    if (uniqueWeeklySnapshots.length >= 2) {
        const previousWeekly =
            uniqueWeeklySnapshots[uniqueWeeklySnapshots.length - 2];
    
        const currentWeekly =
            uniqueWeeklySnapshots[uniqueWeeklySnapshots.length - 1];
      
        for (const [key, brokerName] of Object.entries(brokerMap)) {
            const getBrokerPosition = item =>
                item.futureOpenInterest
                    ?.products?.["日経225先物"]
                    ?.brokers?.[brokerName] || {
                        sell: 0,
                        buy: 0,
                        net: 0
                    };
    
            const previous =
                getBrokerPosition(previousWeekly);
    
            const current =
                getBrokerPosition(currentWeekly);
    
                const delta = {
                    sell: current.sell - previous.sell,
                    buy: current.buy - previous.buy,
                    net: current.net - previous.net
                };
                
                let status = "unconfirmed";

if (delta.buy > 0 && delta.sell <= 0) {
    status = "estimatedBuy";
} else if (delta.sell > 0 && delta.buy <= 0) {
    status = "estimatedSell";
} else if (delta.buy < 0 && delta.sell === 0) {
    status = "reducedBuy";
} else if (delta.sell < 0 && delta.buy === 0) {
    status = "reducedSell";
}
                
            weeklyBrokerDiffs[key] = {
                brokerName,
                from: previousWeekly.date,
                to: currentWeekly.date,
    
                previous: {
                    sell: previous.sell,
                    buy: previous.buy,
                    net: previous.net
                },
    
                current: {
                    sell: current.sell,
                    buy: current.buy,
                    net: current.net
                },
    
                delta,
                status
            };
        }
    
        console.log(
            "📊 主要5社 週次差分 =",
            weeklyBrokerDiffs
        );

        const weeklyStatusLabels = {
            estimatedBuy: "🔵 買い推定",
            estimatedSell: "🔴 売り推定",
            reducedBuy: "↘️ 買い縮小",
            reducedSell: "↗️ 売り縮小",
            unconfirmed: "○ 未確定"
        };
        
        const weeklyStatusIds = {
            JPM: "weeklyStatusJPM",
            GS: "weeklyStatusGS",
            NOMURA: "weeklyStatusNOMURA",
            BNP: "weeklyStatusBNP",
            ABN: "weeklyStatusABN"
        };
        
        const weeklyDirectionElement =
        document.getElementById("weeklyBrokerDirection");
    
        if (weeklyDirectionElement) {
            let buyScore = 0;
            let sellScore = 0;
        
            for (const item of Object.values(weeklyBrokerDiffs)) {
                if (!item) continue;
        
                const previousTotal =
                    Math.abs(item.previous?.buy || 0) +
                    Math.abs(item.previous?.sell || 0);
        
                if (previousTotal <= 0) continue;
        
                if (item.status === "estimatedBuy") {
                    const changeRate =
                        Math.abs(item.delta?.buy || 0) / previousTotal;
        
                    buyScore += changeRate;
                }
        
                if (item.status === "estimatedSell") {
                    const changeRate =
                        Math.abs(item.delta?.sell || 0) / previousTotal;
        
                    sellScore += changeRate;
                }
            }
        
            const scoreDiff = buyScore - sellScore;

            let weeklyDirection = "方向感薄い";
        
            if (scoreDiff >= 0.10) {
                weeklyDirection = "強い買い優勢";
                weeklyDirectionElement.textContent = "🔵 強い買い優勢";
            } else if (scoreDiff >= 0.02) {
                weeklyDirection = "買い優勢";
                weeklyDirectionElement.textContent = "🔵 買い優勢";
            } else if (scoreDiff <= -0.10) {
                weeklyDirection = "強い売り優勢";
                weeklyDirectionElement.textContent = "🔴 強い売り優勢";
            } else if (scoreDiff <= -0.02) {
                weeklyDirection = "売り優勢";
                weeklyDirectionElement.textContent = "🔴 売り優勢";
            } else {
                weeklyDirectionElement.textContent = "○ 方向感薄い";
            }

            if (weeklyBrokerCommentElement) {
                const displayBrokerNames = {
                    JPM: "JPM",
                    GS: "GS",
                    NOMURA: "野村",
                    BNP: "BNP",
                    ABN: "ABN"
                };

                const brokerKeysByStatus = status =>
                    Object.entries(weeklyBrokerDiffs)
                        .filter(([, item]) => item?.status === status)
                        .map(([key]) => displayBrokerNames[key] || key);

                const estimatedBuyBrokers =
                    brokerKeysByStatus("estimatedBuy");
                const estimatedSellBrokers =
                    brokerKeysByStatus("estimatedSell");
                const reducedBuyBrokers =
                    brokerKeysByStatus("reducedBuy");
                const reducedSellBrokers =
                    brokerKeysByStatus("reducedSell");
                const unconfirmedBrokers =
                    brokerKeysByStatus("unconfirmed");

                const details = [];

                if (reducedBuyBrokers.length > 0) {
                    details.push(
                        `${reducedBuyBrokers.join("・")}は買い縮小`
                    );
                }

                if (reducedSellBrokers.length > 0) {
                    details.push(
                        `${reducedSellBrokers.join("・")}は売り縮小`
                    );
                }

                if (unconfirmedBrokers.length > 0) {
                    details.push(
                        `${unconfirmedBrokers.join("・")}は未確定`
                    );
                }

                const buyCount = estimatedBuyBrokers.length;
                const sellCount = estimatedSellBrokers.length;

                let conclusion = "";

                if (
                    buyCount > sellCount &&
                    weeklyDirection.includes("売り優勢")
                ) {
                    conclusion =
                        "買い推定の社数が上回っていますが、" +
                        "売り方向の変化率が相対的に大きく、" +
                        `週次では${weeklyDirection}と判断します。`;
                } else if (
                    sellCount > buyCount &&
                    weeklyDirection.includes("買い優勢")
                ) {
                    conclusion =
                        "売り推定の社数が上回っていますが、" +
                        "買い方向の変化率が相対的に大きく、" +
                        `週次では${weeklyDirection}と判断します。`;
                } else if (
                    buyCount === sellCount &&
                    weeklyDirection.includes("買い優勢")
                ) {
                    conclusion =
                        "買い推定と売り推定の社数は同数ですが、" +
                        "買い方向の変化率が上回っており、" +
                        `週次では${weeklyDirection}と判断します。`;
                } else if (
                    buyCount === sellCount &&
                    weeklyDirection.includes("売り優勢")
                ) {
                    conclusion =
                        "買い推定と売り推定の社数は同数ですが、" +
                        "売り方向の変化率が上回っており、" +
                        `週次では${weeklyDirection}と判断します。`;
                } else if (weeklyDirection === "強い買い優勢") {
                    conclusion =
                        "買い方向への変化が強く、" +
                        "週次では強い買い優勢と判断します。";
                } else if (weeklyDirection === "買い優勢") {
                    conclusion =
                        "買い方向の変化率が上回っており、" +
                        "週次では買い優勢と判断します。";
                } else if (weeklyDirection === "強い売り優勢") {
                    conclusion =
                        "売り方向への変化が強く、" +
                        "週次では強い売り優勢と判断します。";
                } else if (weeklyDirection === "売り優勢") {
                    conclusion =
                        "売り方向の変化率が上回っており、" +
                        "週次では売り優勢と判断します。";
                } else if (buyCount !== sellCount) {
                    conclusion =
                        "推定社数には偏りがありますが、" +
                        "買い・売りの変化率スコア差は小さく、" +
                        "週次では方向感が薄いと判断します。";
                } else {
                    conclusion =
                        "買い・売りの変化率スコア差が小さく、" +
                        "週次では方向感が薄いと判断します。";
                }

                const detailText =
                    details.length > 0
                        ? `${details.join("、")}となっています。`
                        : "";

                weeklyBrokerCommentElement.textContent =
                    `主要5社では買い推定が${buyCount}社、` +
                    `売り推定が${sellCount}社です。` +
                    detailText +
                    conclusion;
            }
        
            console.log("🧭 週次総合スコア =", {
                buyScore,
                sellScore,
                scoreDiff
            });
        }

        for (const [key, elementId] of Object.entries(weeklyStatusIds)) {
            const element = document.getElementById(elementId);
        
            if (!element) continue;
        
            const status =
                weeklyBrokerDiffs[key]?.status || "unconfirmed";
        
            element.textContent =
                weeklyStatusLabels[status] || "○ 未確定";
        }

    }

    if (uniqueWeeklySnapshots.length >= 2) {
        for (let i = 1; i < uniqueWeeklySnapshots.length; i++) {
            const previousWeekly =
                uniqueWeeklySnapshots[i - 1];
    
            const currentWeekly =
                uniqueWeeklySnapshots[i];
    
                const intervalBrokers = {};

                for (const [key, brokerName] of Object.entries(brokerMap)) {
                    const getBrokerPosition = item =>
                        item.futureOpenInterest
                            ?.products?.["日経225先物"]
                            ?.brokers?.[brokerName] || {
                                sell: 0,
                                buy: 0,
                                net: 0
                            };
                
                    const previous =
                        getBrokerPosition(previousWeekly);
                
                    const current =
                        getBrokerPosition(currentWeekly);
                
                    const delta = {
                        sell: current.sell - previous.sell,
                        buy: current.buy - previous.buy,
                        net: current.net - previous.net
                    };
                
                    let status = "unconfirmed";
                
                    if (delta.buy > 0 && delta.sell <= 0) {
                        status = "estimatedBuy";
                    } else if (delta.sell > 0 && delta.buy <= 0) {
                        status = "estimatedSell";
                    }
                
                    intervalBrokers[key] = {
                        brokerName,
                        delta,
                        status
                    };
                }
                
                weeklyBrokerHistory.push({
                    from: previousWeekly.date,
                    to: currentWeekly.date,
                    brokers: intervalBrokers
                });
        }
    }
    
    console.log(
        "🗂 週次判定区間一覧 =",
        weeklyBrokerHistory
    );


        updateIntelligenceCard(
            savedSnapshots
        );

        console.log("📈 累積グラフ用 savedSnapshots =", savedSnapshots);

        const cumulativeDates = savedSnapshots.map(snapshot =>
            snapshot.sourceDate.slice(0, 10)
        );
        
        console.log("📅 日付一覧 =", cumulativeDates);

        const latestSnapshotsByDay = [];


        
const snapshotMap = new Map();

savedSnapshots.forEach(snapshot => {
    const day = snapshot.sourceDate.slice(0, 10);
    snapshotMap.set(day, snapshot);
});

snapshotMap.forEach(snapshot => {
    latestSnapshotsByDay.push(snapshot);
});

const testSnapshot =
  latestSnapshotsByDay[latestSnapshotsByDay.length - 1];

  
console.log("snapshotの中身", testSnapshot);

const cumulativeCompanySelect =
  document.getElementById("cumulativeBrokerSelect");

const companyMap = {
    JPM: "ＪＰモルガン証券",
    GS: "ゴールドマン証券",
    NOMURA: "野村証券",
    BNP: "ＢＮＰパリバ証券",
    ABN: "ＡＢＮクリアリン証券"
  };
  
  const companyName =
    companyMap[cumulativeCompanySelect.value] ||
    "ＪＰモルガン証券";

const dayAuctionRecords =
  testSnapshot?.parsedDayData?.dayAuction?.large?.records || [];

const dayJnetRecords =
  testSnapshot?.parsedDayData?.dayJnet?.large?.records || [];

const nightAuctionRecords =
  testSnapshot?.parsedDayData?.nightAuction?.large?.records || [];

const nightJnetRecords =
  testSnapshot?.parsedDayData?.nightJnet?.large?.records || [];

const findCompanyVolume = (records, companyName) => {
  return records
    .filter(item => item.company === companyName)
    .reduce((sum, item) => sum + (Number(item.volume) || 0), 0);
};

console.log(
    "🏢 会社名一覧 =",
    [...new Set([
      ...dayAuctionRecords,
      ...dayJnetRecords,
      ...nightAuctionRecords,
      ...nightJnetRecords
    ].map(item => item.company))]
  );

const jpmDayVolume =
  findCompanyVolume(dayAuctionRecords, companyName) +
  findCompanyVolume(dayJnetRecords, companyName);

const jpmNightVolume =
  findCompanyVolume(nightAuctionRecords, companyName) +
  findCompanyVolume(nightJnetRecords, companyName);

console.log("📊 JPMテスト =", {
  date: testSnapshot?.sourceDate?.slice(0, 10),
  day: jpmDayVolume,
  night: jpmNightVolume
});

const cumulativePeriodSelect =
    document.getElementById("cumulativePeriodSelect");

const selectedPeriod =
    cumulativePeriodSelect?.value || "20";

// parsedDayData がある営業日だけ
const validCumulativeSnapshots =
    latestSnapshotsByDay.filter(
        snapshot => snapshot?.parsedDayData
    );

let displaySnapshots = [...validCumulativeSnapshots];

if (selectedPeriod === "20") {

    // 直近20営業日
    displaySnapshots =
        validCumulativeSnapshots.slice(-20);

} else if (
    selectedPeriod === "1m" ||
    selectedPeriod === "3m"
) {

    // 最新データの日付を基準にする
    const latestSnapshot =
        validCumulativeSnapshots[
            validCumulativeSnapshots.length - 1
        ];

    if (latestSnapshot) {
        const latestDate =
            new Date(latestSnapshot.sourceDate);

        const cutoffDate =
            new Date(latestDate);

        cutoffDate.setMonth(
            cutoffDate.getMonth() -
            (selectedPeriod === "1m" ? 1 : 3)
        );

        displaySnapshots =
            validCumulativeSnapshots.filter(
                snapshot =>
                    new Date(snapshot.sourceDate) >= cutoffDate
            );
    }
}

console.log(
    "📊 累積グラフ表示期間 =",
    selectedPeriod,
    displaySnapshots.map(
        snapshot => snapshot.sourceDate.slice(0, 10)
    )
);

const selectedBrokerKey =
    cumulativeCompanySelect?.value || "JPM";

const selectedWeeklyStatus =
    weeklyBrokerDiffs[selectedBrokerKey]?.status || "unconfirmed";

console.log(
    "🎨 累積グラフ判定 =",
    selectedBrokerKey,
    selectedWeeklyStatus
);

const getStatusForDate = date => {
    const interval = weeklyBrokerHistory.find(item =>
        date > item.from &&
        date <= item.to
    );

    if (!interval) {
        return "unconfirmed";
    }

    return (
        interval.brokers?.[selectedBrokerKey]?.status ||
        "unconfirmed"
    );
};

const companyDailySeries = displaySnapshots
  .filter(snapshot => snapshot?.parsedDayData)
  .map(snapshot => {
    const dayAuctionRecords =
      snapshot.parsedDayData?.dayAuction?.large?.records || [];

    const dayJnetRecords =
      snapshot.parsedDayData?.dayJnet?.large?.records || [];

    const nightAuctionRecords =
      snapshot.parsedDayData?.nightAuction?.large?.records || [];

    const nightJnetRecords =
      snapshot.parsedDayData?.nightJnet?.large?.records || [];

    const day =
      findCompanyVolume(dayAuctionRecords, companyName) +
      findCompanyVolume(dayJnetRecords, companyName);

    const night =
      findCompanyVolume(nightAuctionRecords, companyName) +
      findCompanyVolume(nightJnetRecords, companyName);

      const date =
      snapshot.sourceDate.slice(0, 10);
  
      const status = getStatusForDate(date);

    
  return {
    date,
    day,
    night,
    status
};
  });

console.log("📈 JPM日付別シリーズ =", companyDailySeries);

const cumulativeCanvas = document.getElementById("cumulativeChart");

if (cumulativeCanvas) {
  if (window.cumulativeChartInstance) {
    window.cumulativeChartInstance.destroy();
  }

  window.cumulativeChartInstance = new Chart(cumulativeCanvas, {
    type: "bar",
    data: {
      labels: companyDailySeries.map(item => item.date),
      datasets: [
        {
            label: "日中",
            data: companyDailySeries.map(item => item.day),
            backgroundColor: companyDailySeries.map(item => {
                if (item.status === "estimatedBuy") {
                    return "rgba(54, 162, 235, 0.85)";
                }
        
                if (item.status === "estimatedSell") {
                    return "rgba(255, 99, 132, 0.85)";
                }
        
                return "rgba(140, 140, 140, 0.60)";
            })
        },
        {
            label: "夜間",
            data: companyDailySeries.map(item => item.night),
            backgroundColor: companyDailySeries.map(item => {
                if (item.status === "estimatedBuy") {
                    return "rgba(54, 162, 235, 0.35)";
                }
        
                if (item.status === "estimatedSell") {
                    return "rgba(255, 99, 132, 0.35)";
                }
        
                return "rgba(180, 180, 180, 0.30)";
            })
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: {
          title: {
            display: true,
            text: "日付"
          }
        },
        y: {
          beginAtZero: true,
          title: {
            display: true,
            text: "取引枚数"
          }
        }
      }
    }
  });
}

console.log(
    "📦 日毎最新データ =",
    latestSnapshotsByDay
);

const jpmData = latestSnapshotsByDay.map(snapshot => {
    return {
        date: snapshot.sourceDate.slice(0, 10),
        brokerData: snapshot.brokerData
    };
});

const jpmLargeData = latestSnapshotsByDay.map(snapshot => ({
    date: snapshot.sourceDate.slice(0, 10),
    large: snapshot.brokerData?.night?.JPM?.large
}));

console.log(
    "🔍 brokerData中身 =",
    latestSnapshotsByDay[24].brokerData
);

console.log("🏦 JPMラージ =", jpmLargeData);

console.log("🏦 JPM抽出前データ =", jpmData);

    } catch (error) {
        console.error(
            "保存済みJPXデータを読み込めませんでした:",
            error
        );

        savedSnapshotList.textContent =
            "保存データの読み込みに失敗しました";

        return;
    }

    savedSnapshotList.innerHTML = "";

    if (savedSnapshots.length === 0) {
        savedSnapshotList.textContent =
            "保存済みデータはありません";
        return;
    }

    // 新しいデータを上に表示
    const newestFirst = [...savedSnapshots].sort(
        (a, b) =>
            new Date(b.sourceDate) -
            new Date(a.sourceDate)
    );

    newestFirst.forEach((snapshot, index) => {

        const item =
            document.createElement("div");

        item.className =
            "saved-snapshot-item";

        const date =
            new Date(snapshot.sourceDate);

        const savedAt =
            new Date(snapshot.savedAt);

        const dataCount =
            Array.isArray(snapshot.labels)
                ? snapshot.labels.length
                : 0;

                item.innerHTML = `
                <div>
                    <div class="saved-snapshot-date">
                        ${index + 1}.　
                        ${date.toLocaleString("ja-JP", {
                            year: "numeric",
                            month: "numeric",
                            day: "numeric",
                            hour: "2-digit",
                            minute: "2-digit"
                        })}
                    </div>
            
                <div class="snapshot-tags">
                         ${(snapshot.tags || [])
                             .map(tag => `<span class="snapshot-tag">${tag}</span>`)
                             .join("")}
                </div>

                ${snapshot.memo ? `
                    <div class="snapshot-memo">
                        📝 ${snapshot.memo}
                    </div>
                ` : ""}
                
                <button
                    type="button"
                    class="edit-snapshot-memo-button"
                    data-index="${index}"
                >
                    メモを編集
                </button>

                    <div class="saved-snapshot-detail">
                        ${dataCount.toLocaleString()}価格帯
                        ・保存：
                        ${savedAt.toLocaleString("ja-JP", {
                            month: "numeric",
                            day: "numeric",
                            hour: "2-digit",
                            minute: "2-digit"
                        })}
                    </div>
                </div>
            
                <button
                    type="button"
                    class="show-snapshot-button"
                >
                    表示
                </button>
        
                <button
                    type="button"
                    class="compare-snapshot-button"
                >
                    比較
</button>

`;

            

    const showButton =
    item.querySelector(".show-snapshot-button");

if (showButton) {
    showButton.addEventListener(
        "click",
        function () {
    const snapshotDate =
    new Date(snapshot.sourceDate);

    nightData.value = snapshot.nightData || "";
    dayData.value = snapshot.dayData || "";
    optionData.value = snapshot.optionData || "";
    localStorage.setItem("optionMapNightData", nightData.value);
    localStorage.setItem("optionMapDayData", dayData.value);
    localStorage.setItem("optionMapOptionData", optionData.value);

// 保存データを現在の表示用データにする
allJpxLabels =
    Array.isArray(snapshot.labels)
        ? [...snapshot.labels]
        : [];

allJpxCallValues =
    Array.isArray(snapshot.callOpenInterest)
        ? [...snapshot.callOpenInterest]
        : [];

allJpxPutValues =
    Array.isArray(snapshot.putOpenInterest)
        ? [...snapshot.putOpenInterest]
        : [];

allJpxCallVolumes =
    Array.isArray(snapshot.callVolume)
        ? [...snapshot.callVolume]
        : [];

allJpxPutVolumes =
    Array.isArray(snapshot.putVolume)
        ? [...snapshot.putVolume]
        : [];

// データ日時も保存日のものへ変更
if (
    typeof window.setJpxSourceTime === "function" &&
    !Number.isNaN(snapshotDate.getTime())
) {
    window.setJpxSourceTime(snapshotDate);
}

// グラフと壁候補を再描画
window.drawJpxPriceChart(
    allJpxLabels,
    allJpxCallValues,
    allJpxPutValues,
    allJpxCallVolumes,
    allJpxPutVolumes
);

const worldMarketImageArea =
    document.getElementById("worldMarketImageArea");

if (worldMarketImageArea) {
    if (snapshot.worldMarketImage) {
        worldMarketImageArea.innerHTML = `
            <h3>世界の株価スクショ</h3>
    
            <img
                src="${snapshot.worldMarketImage}"
                alt="世界の株価スクショ"
                style="max-width:100%;height:auto;"
            >
    
            <br><br>
    
            <button id="analyzeWorldMarketButton">
                🤖 AIで分析
            </button>
    
            <div id="worldMarketAnalysisResult"></div>
        `;
    }
    else {
        worldMarketImageArea.innerHTML = `
            <p>この保存データには世界の株価スクショがありません。</p>
        `;
    }
}

const analyzeWorldMarketButton =
    document.getElementById("analyzeWorldMarketButton");

const worldMarketAnalysisResult =
    document.getElementById("worldMarketAnalysisResult");

if (analyzeWorldMarketButton && worldMarketAnalysisResult) {
    analyzeWorldMarketButton.addEventListener("click", () => {
        worldMarketAnalysisResult.innerHTML =
            "<p>🔍 AIが世界市場を分析中です...</p>";
    });
}

console.log(
    "保存済みJPXデータを表示:",
    snapshot
);
        }
    );
}


const editMemoButton =
    item.querySelector(".edit-snapshot-memo-button");

if (editMemoButton) {
    editMemoButton.addEventListener("click", function () {
        const existingEditor =
            item.querySelector(".snapshot-memo-editor");

        if (existingEditor) {
            existingEditor.remove();
            return;
        }

        const editor = document.createElement("div");
        editor.className = "snapshot-memo-editor";

        const textarea = document.createElement("textarea");
        textarea.value = snapshot.memo || "";
        textarea.rows = 8;
        textarea.style.width = "100%";

        const saveButton = document.createElement("button");
        saveButton.type = "button";
        saveButton.textContent = "変更を保存";

        const cancelButton = document.createElement("button");
        cancelButton.type = "button";
        cancelButton.textContent = "キャンセル";

        editor.appendChild(textarea);
        editor.appendChild(saveButton);
        editor.appendChild(cancelButton);

        editMemoButton.insertAdjacentElement(
            "afterend",
            editor
        );

        saveButton.addEventListener("click", function () {
            snapshot.memo = textarea.value;

            localStorage.setItem(
                storageKey,
                JSON.stringify(savedSnapshots)
            );

            renderSavedSnapshots();
        });

        cancelButton.addEventListener("click", function () {
            editor.remove();
        });
    });
}

const compareButton =
    item.querySelector(".compare-snapshot-button");

if (compareButton) {
    compareButton.addEventListener(
        "click",
        function () {
            comparisonSnapshot = snapshot;

const comparisonSnapshotStatus =
    document.getElementById(
        "comparisonSnapshotStatus"
    );

const comparisonDate =
    new Date(snapshot.sourceDate);

if (comparisonSnapshotStatus) {
    comparisonSnapshotStatus.textContent =
        comparisonDate.toLocaleString(
            "ja-JP",
            {
                year: "numeric",
                month: "numeric",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit"
            }
        );
}

console.log(
    "比較対象に選択:",
    comparisonSnapshot
);

// 比較時に週次指数先物建玉を自動解析
const futureOpenInterestText =
    futureOpenInterestData.value;

    if (futureOpenInterestText.trim()) {
        latestFutureOpenInterestResult =
            analyzeFutureOpenInterestData(
                futureOpenInterestText
            );
    }
const callDifferenceData =
    createDifferenceData(
        allJpxLabels,
        allJpxCallValues,
        comparisonSnapshot.labels,
        comparisonSnapshot.callOpenInterest
    );

const putDifferenceData =
    createDifferenceData(
        allJpxLabels,
        allJpxPutValues,
        comparisonSnapshot.labels,
        comparisonSnapshot.putOpenInterest
    );

console.log(
    "CALL建玉差分:",
    callDifferenceData
);

console.log(
    "PUT建玉差分:",
    putDifferenceData
);

renderDifferenceRankings(
    callDifferenceData,
    putDifferenceData
);

        }
    );
}

        savedSnapshotList.appendChild(item);
    });
}

const cumulativeBrokerSelect =
  document.getElementById("cumulativeBrokerSelect");

if (cumulativeBrokerSelect) {
  cumulativeBrokerSelect.addEventListener("change", () => {
    renderSavedSnapshots();
  });
}

const cumulativePeriodSelect =
    document.getElementById("cumulativePeriodSelect");

if (cumulativePeriodSelect) {
    cumulativePeriodSelect.addEventListener(
        "change",
        renderSavedSnapshots
    );
}

    function saveCurrentJpxSnapshot() {

    if (
        allJpxLabels.length === 0 ||
        allJpxCallValues.length === 0 ||
        allJpxPutValues.length === 0
    ) {
        alert("保存できるJPXデータがありません");
        return;
    }

    const sourceDate =
        lastJpxFetchedAt instanceof Date &&
        !Number.isNaN(lastJpxFetchedAt.getTime())
            ? lastJpxFetchedAt
            : new Date();

    const snapshot = {
        sourceDate: sourceDate.toISOString(),
        savedAt: new Date().toISOString(),
        tags: [],
        memo:
        document.getElementById("snapshotMemo")?.value.trim() || "",
        worldMarketImage: worldMarketImageData,

        nightData: nightData.value,
        dayData: dayData.value,
        optionData: optionData.value,

        brokerData: {
            night: { ...latestNightBrokerData },
            day: { ...latestDayBrokerData },
            option: { ...latestOptionBrokerData }
        },

        parsedDayData: latestParsedDayData,

        futureBrokerData: {
            night: latestNightFutureTotals,
            day: latestDayFutureTotals
        },
       
        labels: [...allJpxLabels],

        callOpenInterest: [...allJpxCallValues],
        putOpenInterest: [...allJpxPutValues],

        callVolume: [...allJpxCallVolumes],
        putVolume: [...allJpxPutVolumes],
        futureOpenInterest: latestFutureOpenInterestResult,
    };

    console.log("保存直前snapshot =", snapshot);
    console.log("🟣 保存直前 parsedDayData =", latestParsedDayData);
    console.log("🚀 保存前 futureBrokerData =", snapshot.futureBrokerData);

    const storageKey = "optionMapJpxSnapshots";

    const savedSnapshots =
        JSON.parse(
            localStorage.getItem(storageKey) || "[]"
        );

    // 同じ元データ日時なら重複保存せず更新
    const existingIndex =
        savedSnapshots.findIndex(item =>
            item.sourceDate === snapshot.sourceDate
        );

    if (existingIndex >= 0) {
        savedSnapshots[existingIndex] = snapshot;
    } else {
        savedSnapshots.push(snapshot);
    }

    savedSnapshots.sort((a, b) =>
        new Date(a.sourceDate) -
        new Date(b.sourceDate)
    );

    localStorage.setItem(
        storageKey,
        JSON.stringify(savedSnapshots)
    );

    if (snapshotSaveStatus) {
        snapshotSaveStatus.textContent =
            sourceDate.toLocaleString("ja-JP") +
            " のデータを保存しました";
    }

    renderSavedSnapshots();

    const memoElement = document.getElementById("snapshotMemo");

    if (memoElement) {
    
        memoElement.value = "";
    
    }

    console.log(
        "JPXスナップショット保存:",
        snapshot
    );
}

if (saveJpxSnapshotButton) {
    saveJpxSnapshotButton.addEventListener(
        "click",
        saveCurrentJpxSnapshot
    );
}



window.drawJpxPriceChart = function (
    labels,
    callValues,
    putValues,
    callVolumes,
    putVolumes
) {    

    callVolumes = Array.isArray(callVolumes)
    ? callVolumes
    : labels.map(() => 0);

putVolumes = Array.isArray(putVolumes)
    ? putVolumes
    : labels.map(() => 0);


       // 新しく読み込んだJPXデータで毎回更新
allJpxLabels = [...labels];
allJpxCallValues = [...callValues];
allJpxPutValues = [...putValues];
allJpxCallVolumes = [...callVolumes];
allJpxPutVolumes = [...putVolumes];

console.log(
    "JPX全データ更新:",
    allJpxLabels.length,
    "最小:",
    allJpxLabels[0],
    "最大:",
    allJpxLabels[allJpxLabels.length - 1]
);

const isVolumeMode =
    currentChartMode === "volume";

    const chartTitle =
    document.getElementById("combinedChartTitle");

const callWallTitle =
    document.querySelector(".call-wall h3");

const putWallTitle =
    document.querySelector(".put-wall h3");

if (chartTitle) {
    chartTitle.textContent =
        isVolumeMode
            ? "CALL・PUT 本日の取引高"
            : "CALL・PUT建玉残";
}

if (callWallTitle) {
    callWallTitle.textContent =
        isVolumeMode
            ? "上側のCALL取引高上位"
            : "上側のCALL壁候補";
}

if (putWallTitle) {
    putWallTitle.textContent =
        isVolumeMode
            ? "下側のPUT取引高上位"
            : "下側のPUT壁候補";
}

const selectedCallValues =
    isVolumeMode
        ? callVolumes
        : callValues;

const selectedPutValues =
    isVolumeMode
        ? putVolumes
        : putValues;

        const minStrike = currentPrice - 12000;
        const maxStrike = currentPrice + 22000;
    
        // 元データを価格ごとに検索できる形にする
const dataByStrike = new Map();

labels.forEach((label, index) => {

    const strike = Number(
        String(label).replace(/,/g, "")
    );

    dataByStrike.set(strike, {
        callValue:
            Number(selectedCallValues[index]) || 0,
    
        putValue:
            Number(selectedPutValues[index]) || 0
    });
});

// 横軸を125円刻みに統一
const strikeStep = 125;

const startStrike =
    Math.ceil(minStrike / strikeStep) * strikeStep;

const endStrike =
    Math.floor(maxStrike / strikeStep) * strikeStep;

    updateMarketInfo(
        startStrike,
        endStrike
    );

const visibleData = [];

for (
    let strike = startStrike;
    strike <= endStrike;
    strike += strikeStep
) {

    const originalData = dataByStrike.get(strike);

    visibleData.push({
        label: strike.toLocaleString(),
        strike: strike,
        callValue: originalData
            ? originalData.callValue
            : 0,
        putValue: originalData
            ? originalData.putValue
            : 0
    });
}

console.log(

    "visibleData先頭10件:",

    visibleData.slice(0, 10)

);

        labels = visibleData.map(item => item.label);
        callValues = visibleData.map(item => item.callValue);
        putValues = visibleData.map(item => item.putValue);
    
        latestJpxLabels = labels;
        latestCallValues = callValues;
        latestPutValues = putValues;

    
    const canvas =
        document.getElementById("combinedPriceChart");

    if (!canvas) {
        console.error(
            "combinedPriceChartのcanvasが見つかりません"
        );
        return;
    }

    if (combinedPriceChart) {
        combinedPriceChart.destroy();
    }

    const numericCallValues =
        callValues.map(value => Number(value) || 0);

    const numericPutValues =
        putValues.map(value => Number(value) || 0);

    const maxCall =
        Math.max(...numericCallValues, 1);

    const maxPut =
        Math.max(...numericPutValues, 1);

    // CALLは上方向へ0〜100
    const normalizedCallValues =
        numericCallValues.map(value =>
            value / maxCall * 100
        );

    // PUTは下方向へ0〜-100
    const normalizedPutValues =
        numericPutValues.map(value =>
            -(value / maxPut * 100)
        );

    combinedPriceChart = new Chart(canvas, {
        type: "bar",

        plugins: [
            currentPriceLinePlugin,
            combinedWallRankPlugin
        ],

        data: {
            labels: labels,

            datasets: [
                {
                    label: isVolumeMode
                        ? "CALL取引高"
                        : "CALL建玉残",
                    data: normalizedCallValues,

                    backgroundColor: createBarColors(
                        numericCallValues,
                        "rgba(74, 144, 226, 0.45)",
                        "rgba(0, 82, 204, 0.95)"
                    ),

                    borderColor:
                        "rgba(74, 144, 226, 1)",

                    borderWidth: 1
                },
                {
                    label: isVolumeMode
                        ? "PUT取引高"
                        : "PUT建玉残",
                    data: normalizedPutValues,

                    backgroundColor: createBarColors(
                        numericPutValues,
                        "rgba(255, 99, 132, 0.45)",
                        "rgba(220, 20, 60, 0.95)"
                    ),

                    borderColor:
                        "rgba(255, 99, 132, 1)",

                    borderWidth: 1
                }
            ]
        },

        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            layout: {

                padding: {
        
                    left: 10,
        
                    right: 25,
        
                    top: 10,
        
                    bottom: 5
        
                }
        
            },
            scales: {
                x: {
                    stacked: false,

                    ticks: {
                        autoSkip: true,
                        maxRotation: 45,
                        minRotation: 45
                    }
                },

                y: {
                    min: -115,
                    max: 115,

                    ticks: {
                        stepSize: 100,
                    
                        callback: function (value) {
                    
                            if (value === 100) {
                                return "CALL";
                            }
                    
                            if (value === 0) {
                                return "0";
                            }
                    
                            if (value === -100) {
                                return "PUT";
                            }
                    
                            return "";
                        }
                    },

                    grid: {
                        color: function (context) {

                            if (context.tick.value === 0) {
                                return "rgba(0, 0, 0, 0.75)";
                            }

                            return "rgba(0, 0, 0, 0.1)";
                        },

                        lineWidth: function (context) {

                            return context.tick.value === 0
                                ? 2
                                : 1;
                        }
                    }
                }
            },

            plugins: {
                legend: {
                    display: true
                },

                tooltip: {
                    callbacks: {
                        label: function (context) {

                            const index =
                                context.dataIndex;

                            if (
                                context.datasetIndex === 0
                            ) {
                                return (
                                    (isVolumeMode

                                        ? "CALL取引高："
                                
                                        : "CALL建玉残：")  +
                                    numericCallValues[index]
                                        .toLocaleString() +
                                    "枚"
                                );
                            }

                            return (
                                (isVolumeMode

                                     ? "PUT取引高："

                                     : "PUT建玉残：") +
                                numericPutValues[index]
                                    .toLocaleString() +
                                "枚"
                            );
                        }
                    }
                }
            }
        }
    });

    updateWallCandidates(
        labels,
        numericCallValues,
        numericPutValues
    );

    console.log(
        "CALL・PUT統合グラフ作成成功"
    );
};


function showOptionMap() {

    const result = document.getElementById("optionMapResult");

    result.innerHTML = "";

    const prices = Object.keys(optionMap).sort((a, b) => Number(a) - Number(b));

    for (const price of prices) {

        const title = document.createElement("h3");
        title.textContent = Number(price).toLocaleString() + " 円";
        result.appendChild(title);

        const ul = document.createElement("ul");

        const companies = optionMap[price];

        for (const company in companies) {

            const li = document.createElement("li");

            li.textContent =
                (companyNames[company] || company) +
                " : " +
                companies[company] +
                "枚";

            ul.appendChild(li);
        }

        result.appendChild(ul);

    }

}

function drawOptionTable() {

    const companies = [
        "BNP",
        "JPM",
        "ABN",
        "UBS",
        "Barclays",
        "SG",
        "Goldman",
        "Rakuten",
        "Matsui",
        "MorganMUFG"
    ];

    const table = document.getElementById("optionMapTable");
    table.innerHTML = "";

    // ヘッダー
    const header = document.createElement("tr");

    const thPrice = document.createElement("th");
    thPrice.textContent = "価格";
    header.appendChild(thPrice);

    const thTotal = document.createElement("th");
    thTotal.textContent = "合計";
    header.appendChild(thTotal);

    for (const company of companies) {

        const th = document.createElement("th");
        th.textContent = company;
        header.appendChild(th);

    }

    table.appendChild(header);

    // データ行
    const prices = Object.keys(optionMap).sort((a, b) => Number(a) - Number(b));

    for (const price of prices) {

        const tr = document.createElement("tr");

        // 価格
        const tdPrice = document.createElement("td");
        tdPrice.textContent = Number(price).toLocaleString() + "円";
        tdPrice.style.fontWeight = "bold";
        tdPrice.style.textAlign = "center";
        tr.appendChild(tdPrice);

        // 合計を計算
        let total = 0;

        for (const company of companies) {
            total += optionMap[price][company] || 0;
        }

        // 合計セル
        const tdTotal = document.createElement("td");
        tdTotal.textContent = total.toLocaleString();
        tdTotal.style.fontWeight = "bold";
        tdTotal.style.textAlign = "center";



        if (total >= 3000) {
            tdTotal.style.backgroundColor = "#ff4d4d";
        }
        else if (total >= 500) {
            tdTotal.style.backgroundColor = "#ff9933";
        }
        else if (total >= 100) {
            tdTotal.style.backgroundColor = "#ffd966";
        }
        else if (total >= 1) {
            tdTotal.style.backgroundColor = "#b6d7a8";
        }

        tr.appendChild(tdTotal);

        // 各会社
        for (const company of companies) {

            const td = document.createElement("td");

            const value = optionMap[price][company] || 0;

            td.textContent = value.toLocaleString();
            td.style.textAlign = "center";
            td.style.fontWeight = "bold";

            if (value >= 3000) {
                td.style.backgroundColor = "#ff4d4d";
            }
            else if (value >= 500) {
                td.style.backgroundColor = "#ff9933";
            }
            else if (value >= 100) {
                td.style.backgroundColor = "#ffd966";
            }
            else if (value >= 1) {
                td.style.backgroundColor = "#b6d7a8";
            }

            if (value === 0) {
                td.style.color = "#cccccc";
            }

            tr.appendChild(td);

        }

        table.appendChild(tr);

    }

}

function showMaxPosition(priceTotals) {

    let maxPrice = "";
    let maxValue = 0;

    for (const price in priceTotals) {

        const value = priceTotals[price];

        if (value > maxValue) {

            maxValue = value;
            maxPrice = price;

        }

    }



const result = document.getElementById("maxPosition");


result.innerHTML = `
    <p><strong>価格帯</strong></p>
    <h2>${Number(maxPrice).toLocaleString()}円</h2>

   
    <p><strong>建玉</strong></p>
    <h2>${maxValue.toLocaleString()}枚</h2>
`;    

}

function showPriceRanking() {

    const ranking = [];

    for (const price in optionMap) {

        let total = 0;

        for (const company in optionMap[price]) {
            total += optionMap[price][company];
        }

        ranking.push({
            price: price,
            total: total

        });

    }

    ranking.sort((a, b) => b.total - a.total);

    const result = document.getElementById("priceRanking");

    result.innerHTML = "";

    for (const item of ranking) {

        result.innerHTML += `
        <p>${Number(item.price).toLocaleString()}円 : ${item.total.toLocaleString()}枚</p>
        `;

    }
}

function createDifferenceData(
    currentLabels,
    currentValues,
    compareLabels,
    compareValues
) {
    const currentMap = new Map();
    const compareMap = new Map();

    currentLabels.forEach((label, index) => {
        const strike = Number(
            String(label).replace(/,/g, "")
        );

        if (!Number.isFinite(strike)) return;

        currentMap.set(
            strike,
            Number(currentValues[index]) || 0
        );
    });

    compareLabels.forEach((label, index) => {
        const strike = Number(
            String(label).replace(/,/g, "")
        );

        if (!Number.isFinite(strike)) return;

        compareMap.set(
            strike,
            Number(compareValues[index]) || 0
        );
    });

    // 今日か比較対象のどちらかにある価格帯をすべて対象にする
    const allStrikes = [
        ...new Set([
            ...currentMap.keys(),
            ...compareMap.keys()
        ])
    ].sort((a, b) => a - b);

    return allStrikes.map(strike => {
        const current =
            currentMap.get(strike) || 0;

        const previous =
            compareMap.get(strike) || 0;

        return {
            strike,
            current,
            previous,
            diff: current - previous
        };
    });
}

function createDiagnosisSentence(reasons, marketLevel) {
    // 文字列とオブジェクトの両方に対応
    const reasonTexts = reasons
        .filter(reason => reason)
        .sort((a, b) => {
            const priorityA =
                typeof a === "object" ? a.priority ?? 0 : 0;

            const priorityB =
                typeof b === "object" ? b.priority ?? 0 : 0;

            return priorityB - priorityA;
        })
        .map(reason => {
            return typeof reason === "object"
                ? reason.text
                : reason;
        })
        .filter(text => typeof text === "string" && text.trim() !== "");

    // 同じ理由が重複した場合は1つにする
    const uniqueReasons = [...new Set(reasonTexts)]
        .slice(0, 3);

    if (uniqueReasons.length === 0) {
        if (marketLevel.includes("強気")) {
            return "強気材料がやや優勢ですが、明確な決め手はまだ確認できません。";
        }

        if (marketLevel.includes("弱気")) {
            return "弱気材料がやや優勢ですが、明確な決め手はまだ確認できません。";
        }

        return "強気材料と弱気材料が拮抗しており、方向感はまだ明確ではありません。";
    }

    // 表示用に少し自然な表現へ整える
    const formattedReasons = uniqueReasons.map(text => {
        return text
            .replace(
                "現在値付近でCALL建玉が増加",
                "現在値付近でのCALL建玉増加"
            )
            .replace(
                "現在値付近でPUT建玉が減少",
                "現在値付近でのPUT建玉減少"
            )
            .replace(
                "現在値付近でPUT建玉が増加",
                "現在値付近でのPUT建玉増加"
            )
            .replace(
                "現在値付近でCALL建玉が減少",
                "現在値付近でのCALL建玉減少"
            )
            .replace(
                "CALL建玉が大きく増加",
                "CALL建玉の大幅な増加"
            )
            .replace(
                "PUT建玉が大きく増加",
                "PUT建玉の大幅な増加"
            )
            .replace(
                "CALL建玉が大きく減少",
                "CALL建玉の大幅な減少"
            )
            .replace(
                "PUT建玉が大きく減少",
                "PUT建玉の大幅な減少"
            )
            .replace(
                "CALL建玉増加",
                "CALL建玉の増加"
            )
            .replace(
                "PUT建玉増加",
                "PUT建玉の増加"
            )
            .replace(
                "CALL建玉減少",
                "CALL建玉の減少"
            )
            .replace(
                "PUT建玉減少",
                "PUT建玉の減少"
            );
    });

    let joinedReasons = "";

    if (formattedReasons.length === 1) {
        joinedReasons = formattedReasons[0];
    }
    else if (formattedReasons.length === 2) {
        joinedReasons =
            `${formattedReasons[0]}と${formattedReasons[1]}`;
    }
    else {
        joinedReasons =
            `${formattedReasons[0]}、${formattedReasons[1]}、` +
            `${formattedReasons[2]}`;
    }

    if (marketLevel.includes("強気")) {
        return `${joinedReasons}が確認され、上方向への意識がやや強まっています。`;
    }

    if (marketLevel.includes("弱気")) {
        return `${joinedReasons}が確認され、下方向への警戒がやや強まっています。`;
    }

    return `${joinedReasons}が確認されていますが、強弱材料が混在しており、方向感はまだ明確ではありません。`;
}

function createAIComment(
    bullishReasons,
    bearishReasons,
    marketLevel,
    futureOpenInterest
) {
    const normalizeReasons = reasons =>
        reasons
            .filter(reason => reason)
            .map(reason => {
                if (typeof reason === "object") {
                    return reason;
                }

                return {
                    text: reason,
                    priority: 0,
                    optionType: "",
                    changeType: "",
                    strike: null,
                    diff: null,
                    distance: null
                };
            });

    const bullishItems =
        normalizeReasons(bullishReasons);

    const bearishItems =
        normalizeReasons(bearishReasons);

    const allItems = [
        ...bullishItems,
        ...bearishItems
    ];

    const weeklyOpenInterestComments = [];

    if (
        futureOpenInterest &&
        futureOpenInterest.brokerTotals
    ) {
        const brokerEntries = Object.entries(
            futureOpenInterest.brokerTotals
        );
    
        const topBuyers = brokerEntries
            .filter(([, values]) => values.buy > 0)
            .sort((a, b) => b[1].buy - a[1].buy)
            .slice(0, 3);
    
        const topSellers = brokerEntries
            .filter(([, values]) => values.sell > 0)
            .sort((a, b) => b[1].sell - a[1].sell)
            .slice(0, 3);

        const topBuyTotal = topBuyers.reduce(
            (sum, [, values]) => sum + values.buy,
                0
            );
            
        const topSellTotal = topSellers.reduce(
            (sum, [, values]) => sum + values.sell,
                0
            );    
    
        if (topBuyers.length > 0) {
            const buyerText = topBuyers
                .map(
                    ([broker, values]) =>
                        `${broker} ${values.buy.toLocaleString()}枚`
                )
                .join("、");
    
        }
    
        if (topSellers.length > 0) {
            const sellerText = topSellers
                .map(
                    ([broker, values]) =>
                        `${broker} ${values.sell.toLocaleString()}枚`
                )
                .join("、");

        }
    
        const totalBuy = brokerEntries.reduce(
            (sum, [, values]) => sum + (values.buy || 0),
            0
        );
        
        const totalSell = brokerEntries.reduce(
            (sum, [, values]) => sum + (values.sell || 0),
            0
        );

        const leadingBuyer =
            topBuyers.length > 0
                ? topBuyers[0]
                : null;

        const leadingSeller =
            topSellers.length > 0
                ? topSellers[0]
                : null;
        
        const balanceDifference = totalBuy - totalSell;

        const topDifference =
            topBuyTotal - topSellTotal;
        
        let weeklyInterpretation = "";

        let leaderComment = "";

        if (leadingBuyer && topBuyers.length >= 2) {
            const buyerName =
                leadingBuyer[0];

            const secondBuyerName =
                topBuyers[1][0];

            const buyerAmount =
                leadingBuyer[1].buy;

            const secondBuyerAmount =
                topBuyers[1][1].buy;

            const buyerLead =
                buyerAmount - secondBuyerAmount;

        if (buyerLead >= 5000) {
            leaderComment =
    `・注目機関：${buyerName}が買いトップで、2位の${secondBuyerName}を${buyerLead.toLocaleString()}枚上回っています。`;
    }
        else {
            leaderComment =
               "・注目機関：買い上位は複数社に分散しており、特定の1社だけが突出している状態ではありません。";
    }
}
        
if (
    topDifference > 5000 &&
    balanceDifference > 10000
) {
    weeklyInterpretation =
        "・勢力図：買い建玉を多く保有する主要証券会社が目立ち、市場全体でも買い建玉が優勢です。比較的買いポジションが集まっています。";
}
else if (
    topDifference > 5000 &&
    balanceDifference < -10000
) {
    weeklyInterpretation =
        "・勢力図：主要証券会社では買い姿勢が目立つ一方、市場全体では売り姿勢が優勢となっており、市場参加者の見方が分かれています。";
}
else if (
    topDifference < -5000 &&
    balanceDifference > 10000
) {
    weeklyInterpretation =
        "・勢力図：売り建玉を多く保有する主要証券会社が目立つ一方、市場全体では買い建玉が優勢です。参加者全体のポジションには違いが見られます。";
}
else if (
    topDifference < -5000 &&
    balanceDifference < -10000
) {
    weeklyInterpretation =
        "・勢力図：売り建玉を多く保有する主要証券会社が目立ち、市場全体でも売り建玉が優勢です。比較的売りポジションが集まっています。";
}
else if (
    Math.abs(topDifference) <= 5000 &&
    Math.abs(balanceDifference) <= 10000
) {
    weeklyInterpretation =
        "・勢力図：買い建玉と売り建玉のバランスが比較的均衡しており、明確な偏りは見られません。";
}
else {
    weeklyInterpretation =
        "・勢力図：主要証券会社と市場全体では建玉の傾向に違いが見られ、参加者の見方はまだ一致していません。";
}
        
        if (leaderComment) {
            weeklyOpenInterestComments.push(
                leaderComment
            );
        }

        weeklyOpenInterestComments.push(
            weeklyInterpretation
        );
    
    }

    const findReason = (
        optionType,
        changeType
    ) =>
        allItems
            .filter(reason =>
                reason.optionType === optionType &&
                reason.changeType === changeType
            )
            .sort((a, b) => {
                const priorityDifference =
                    (b.priority ?? 0) -
                    (a.priority ?? 0);

                if (priorityDifference !== 0) {
                    return priorityDifference;
                }

                return (
                    Math.abs(b.diff ?? 0) -
                    Math.abs(a.diff ?? 0)
                );
            })[0] || null;

    const callIncrease =
        findReason("CALL", "increase");

    const callDecrease =
        findReason("CALL", "decrease");

    const putIncrease =
        findReason("PUT", "increase");

    const putDecrease =
        findReason("PUT", "decrease");

    const formatReason = reason => {
        if (
            !reason ||
            !Number.isFinite(reason.strike) ||
            !Number.isFinite(reason.diff)
        ) {
            return "";
        }

        const changeText =
            reason.changeType === "increase"
                ? "増加"
                : "減少";

        const absoluteDifference =
            Math.abs(reason.diff);

        let distanceText = "";

        if (Number.isFinite(reason.distance)) {
            if (reason.distance <= 250) {
                distanceText =
                    `現在値から${reason.distance.toLocaleString()}円と非常に近い位置です`;
            }
            else if (reason.distance <= 500) {
                distanceText =
                    `現在値から${reason.distance.toLocaleString()}円と近い位置です`;
            }
            else {
                distanceText =
                    `現在値から${reason.distance.toLocaleString()}円離れています`;
            }
        }

        return (
            `${reason.strike.toLocaleString()}円` +
            `${reason.optionType}では` +
            `${absoluteDifference.toLocaleString()}枚の建玉${changeText}が確認され、` +
            distanceText
        );
    };

    const sentences = [];

    if (callIncrease && putDecrease) {
        sentences.push(
            `${formatReason(callIncrease)}。`
        );

        sentences.push(
            `${formatReason(putDecrease)}。`
        );

        sentences.push(
            "CALL増加とPUT減少が重なっており、上方向を意識した建玉変化です。"
        );
    }
    else if (callDecrease && putIncrease) {
        sentences.push(
            `${formatReason(callDecrease)}。`
        );

        sentences.push(
            `${formatReason(putIncrease)}。`
        );

        sentences.push(
            "CALL減少とPUT増加が重なっており、下方向への警戒を示す建玉変化です。"
        );
    }
    else if (callIncrease && putIncrease) {
        sentences.push(
            `${formatReason(callIncrease)}。`
        );

        sentences.push(
            `${formatReason(putIncrease)}。`
        );

        sentences.push(
            "CALL・PUTともに増加しているため、市場参加者の見方が分かれています。"
        );
    }
    else if (callDecrease && putDecrease) {
        sentences.push(
            `${formatReason(callDecrease)}。`
        );

        sentences.push(
            `${formatReason(putDecrease)}。`
        );

        sentences.push(
            "CALL・PUTともに減少しており、ポジション整理が進んでいる可能性があります。"
        );
    }
    else {
        const strongestReason =
            [...allItems]
                .filter(reason =>
                    Number.isFinite(reason.strike) &&
                    Number.isFinite(reason.diff)
                )
                .sort((a, b) =>
                    Math.abs(b.diff) -
                    Math.abs(a.diff)
                )[0];

        if (strongestReason) {
            sentences.push(
                `${formatReason(strongestReason)}。`
            );
        }

        sentences.push(
            "建玉には変化が見られますが、明確な方向性を示す組み合わせではありません。"
        );
    }

    if (marketLevel === "強気") {
        sentences.push(
            "複数の強気材料が重なっているため、現時点では強気と判断します。"
        );
    }
    else if (marketLevel === "やや強気") {
        sentences.push(
            "ただし決定的な偏りではないため、現時点ではやや強気と判断します。"
        );
    }
    else if (marketLevel === "弱気") {
        sentences.push(
            "複数の弱気材料が重なっているため、現時点では弱気と判断します。"
        );
    }
    else if (marketLevel === "やや弱気") {
        sentences.push(
            "ただし決定的な偏りではないため、現時点ではやや弱気と判断します。"
        );
    }
    else {
        sentences.push(
            "強気材料と弱気材料が混在しているため、現時点では中立と判断します。"
        );
    }

    const weeklyCommentText =
    weeklyOpenInterestComments.length > 0
        ? `\n\n【週次指数先物建玉】\n${weeklyOpenInterestComments.join("\n")}`
        : "";

return (
    sentences
        .filter(sentence => sentence)
        .join("") +
    weeklyCommentText
);
}

function renderDifferenceRankings(
    callDifferenceData,
    putDifferenceData
) {
    const callIncrease = [...callDifferenceData]
        .filter(item => item.diff > 0)
        .sort((a, b) => b.diff - a.diff)
        .slice(0, 3);

    const callDecrease = [...callDifferenceData]
        .filter(item => item.diff < 0)
        .sort((a, b) => a.diff - b.diff)
        .slice(0, 3);

    const putIncrease = [...putDifferenceData]
        .filter(item => item.diff > 0)
        .sort((a, b) => b.diff - a.diff)
        .slice(0, 3);

    const putDecrease = [...putDifferenceData]
        .filter(item => item.diff < 0)
        .sort((a, b) => a.diff - b.diff)
        .slice(0, 3);

    function renderList(elementId, items) {
        const element =
            document.getElementById(elementId);

        if (!element) return;

        if (items.length === 0) {
            element.textContent =
                "該当する変化はありません";
            return;
        }

        element.innerHTML = items
            .map((item, index) => {
                const sign =
                    item.diff > 0 ? "+" : "";

                return `
                    <div class="difference-row">
                        <span>
                            ${index + 1}位　
                            ${item.strike.toLocaleString()}円
                        </span>

                        <strong class="${
                            item.diff > 0
                                ? "difference-up"
                                : "difference-down"
                        }">
                            ${sign}${item.diff.toLocaleString()}枚
                        </strong>
                    </div>
                `;
            })
            .join("");
    }

    renderList(
        "callIncreaseResult",
        callIncrease
    );

    renderList(
        "callDecreaseResult",
        callDecrease
    );

    renderList(
        "putIncreaseResult",
        putIncrease
    );

    renderList(
        "putDecreaseResult",
        putDecrease
    );

    // 現在値から±1,000円以内を対象にする
const focusRange = 1000;
const numericCurrentPrice = Number(currentPrice) || 0;

const nearbyCallIncrease = callDifferenceData
    .filter(item =>
        Math.abs(item.strike - numericCurrentPrice) <= focusRange &&
        item.diff > 0
    )
    .sort((a, b) => b.diff - a.diff)[0] || null;

const nearbyCallDecrease = callDifferenceData
    .filter(item =>
        Math.abs(item.strike - numericCurrentPrice) <= focusRange &&
        item.diff < 0
    )
    .sort((a, b) => a.diff - b.diff)[0] || null;

const nearbyPutIncrease = putDifferenceData
    .filter(item =>
        Math.abs(item.strike - numericCurrentPrice) <= focusRange &&
        item.diff > 0
    )
    .sort((a, b) => b.diff - a.diff)[0] || null;

const nearbyPutDecrease = putDifferenceData
    .filter(item =>
        Math.abs(item.strike - numericCurrentPrice) <= focusRange &&
        item.diff < 0
    )
    .sort((a, b) => a.diff - b.diff)[0] || null;


// 注目変化をカードへ表示する
function renderNearbyItem(elementId, item) {
    const element =
        document.getElementById(elementId);

    if (!element) return;

    const card =
        element.closest(".difference-summary-item");

    // 前回付けた距離クラスをいったん外す
    if (card) {
        card.classList.remove(
            "nearby-close",
            "nearby-middle",
            "nearby-far"
        );
    }

    if (!item) {
        element.textContent =
            "±1,000円以内に該当する変化はありません";
        return;
    }

    const differenceFromPrice =
        item.strike - numericCurrentPrice;

    const absoluteDistance =
        Math.abs(differenceFromPrice);

        let attentionLevel = 2;

        if (absoluteDistance <= 250) {
            attentionLevel = 5;
        } else if (absoluteDistance <= 500) {
            attentionLevel = 4;
        } else if (absoluteDistance <= 750) {
            attentionLevel = 3;
        }
        
        const attentionStars =
            "★".repeat(attentionLevel) +
            "☆".repeat(5 - attentionLevel);
        
        const distanceArrow =
            differenceFromPrice > 0
                ? "⬆"
                : differenceFromPrice < 0
                    ? "⬇"
                    : "●";

    // 現在値との距離でカードを色分け
    if (card) {
        if (absoluteDistance <= 250) {
            card.classList.add("nearby-close");
        } else if (absoluteDistance <= 500) {
            card.classList.add("nearby-middle");
        } else {
            card.classList.add("nearby-far");
        }
    }

    const diffSign =
        item.diff > 0 ? "+" : "";

    const distanceSign =
        differenceFromPrice > 0 ? "+" : "";

        element.innerHTML = `
        <div class="nearby-card-header">
            <span class="nearby-attention">
                ${attentionStars}
            </span>
        </div>
    
        <span class="nearby-strike">
            ${item.strike.toLocaleString()}円
        </span>
    
        <strong class="${
            item.diff > 0
                ? "difference-up"
                : "difference-down"
        }">
            ${diffSign}${item.diff.toLocaleString()}枚
        </strong>
    
        <small class="nearby-distance">
            現在値より
            <span class="nearby-arrow">
                ${distanceArrow}
            </span>
            ${absoluteDistance.toLocaleString()}円
        </small>
    `;
}

renderNearbyItem(
    "maxCallIncrease",
    nearbyCallIncrease
);

renderNearbyItem(
    "maxCallDecrease",
    nearbyCallDecrease
);

renderNearbyItem(
    "maxPutIncrease",
    nearbyPutIncrease
);

renderNearbyItem(
    "maxPutDecrease",
    nearbyPutDecrease
);

// 現在値に近い順でカードを並び替える
const nearbyCards = [
    {
        elementId: "maxCallIncrease",
        item: nearbyCallIncrease
    },
    {
        elementId: "maxCallDecrease",
        item: nearbyCallDecrease
    },
    {
        elementId: "maxPutIncrease",
        item: nearbyPutIncrease
    },
    {
        elementId: "maxPutDecrease",
        item: nearbyPutDecrease
    }
];

nearbyCards.sort((a, b) => {
    const distanceA = a.item
        ? Math.abs(
            a.item.strike - numericCurrentPrice
        )
        : Infinity;

    const distanceB = b.item
        ? Math.abs(
            b.item.strike - numericCurrentPrice
        )
        : Infinity;

    return distanceA - distanceB;
});

const summaryGrid =
    document.querySelector(
        ".difference-summary-grid"
    );

if (summaryGrid) {
    nearbyCards.forEach(cardData => {
        const contentElement =
            document.getElementById(
                cardData.elementId
            );

        const card =
            contentElement?.closest(
                ".difference-summary-item"
            );

        if (card) {
            summaryGrid.appendChild(card);
        }
    });
}

console.log(
    "現在値付近CALL増加:",
    nearbyCallIncrease
);

console.log(
    "現在値付近CALL減少:",
    nearbyCallDecrease
);

console.log(
    "現在値付近PUT増加:",
    nearbyPutIncrease
);

console.log(
    "現在値付近PUT減少:",
    nearbyPutDecrease
);

let marketLevel = "中立";
let confidenceScore = 1;
let confidence = "★☆☆☆☆";
let marketIcon = "🟡";

// 市場方向の採点
let bullishScore = 0;
let bearishScore = 0;
let bullishReasons = [];
let bearishReasons = [];

function addDistanceScore(item) {
    if (!item) return 0;

    const distance = Math.abs(item.strike - numericCurrentPrice);

    if (distance <= 100) return 2;
    if (distance <= 300) return 1;

    return 0;
}

// CALL増加は上方向の材料

if (nearbyCallIncrease?.diff > 1000) {
    bullishScore += 2;
    bullishReasons.push({
        text: "CALL建玉が大きく増加",
        priority: 4,

optionType: "CALL",

    changeType: "increase",

    strike: nearbyCallIncrease.strike,

    diff: nearbyCallIncrease.diff,

    distance: Math.abs(

        nearbyCallIncrease.strike -

        numericCurrentPrice

    )
    });

}
else if (nearbyCallIncrease?.diff > 500) {
    bullishScore += 1;
    bullishReasons.push({
        text: "CALL建玉増加",
        priority: 3,
    
        optionType: "CALL",
        changeType: "increase",
    
        strike: nearbyCallIncrease.strike,
        diff: nearbyCallIncrease.diff,
    
        distance: Math.abs(
            nearbyCallIncrease.strike -
            numericCurrentPrice
        )
    });
}



if (nearbyCallIncrease?.diff > 500) {
    const callDistanceScore =
        addDistanceScore(nearbyCallIncrease);

    bullishScore += callDistanceScore;

    if (callDistanceScore > 0) {
        bullishReasons.push({
            text: "現在値付近でCALL建玉増加",
            priority: 5,
        
            optionType: "CALL",
            changeType: "increase",
        
            strike: nearbyCallIncrease.strike,
            diff: nearbyCallIncrease.diff,
        
            distance: Math.abs(
                nearbyCallIncrease.strike -
                numericCurrentPrice
            )
        });
    }
}

// PUT減少は上方向の材料
if (nearbyPutDecrease?.diff < -1000) {
    bullishScore += 2;
    bullishReasons.push({
        text: "PUT建玉が大きく減少",
        priority: 4,
    
        optionType: "PUT",
        changeType: "decrease",
    
        strike: nearbyPutDecrease.strike,
        diff: nearbyPutDecrease.diff,
    
        distance: Math.abs(
            nearbyPutDecrease.strike -
            numericCurrentPrice
        )
    });
}
else if (nearbyPutDecrease?.diff < 0) {
    bullishScore += 1;
    bullishReasons.push({
        text: "PUT建玉が減少",
        priority: 3,
    
        optionType: "PUT",
        changeType: "decrease",
    
        strike: nearbyPutDecrease.strike,
        diff: nearbyPutDecrease.diff,
    
        distance: Math.abs(
            nearbyPutDecrease.strike -
            numericCurrentPrice
        )
    });
}



if (nearbyPutDecrease?.diff < 0) {
    const putDecreaseDistanceScore =
        addDistanceScore(nearbyPutDecrease);

    bullishScore += putDecreaseDistanceScore;

    if (putDecreaseDistanceScore > 0) {
        bullishReasons.push({
            text: "現在値付近でPUT建玉が減少",
            priority: 5,
        
            optionType: "PUT",
            changeType: "decrease",
        
            strike: nearbyPutDecrease.strike,
            diff: nearbyPutDecrease.diff,
        
            distance: Math.abs(
                nearbyPutDecrease.strike -
                numericCurrentPrice
            )
        });
    }
}


// PUT増加は下方向の材料
if (nearbyPutIncrease?.diff > 1000) {
    bearishScore += 2;

    bearishReasons.push({
        text: "PUT建玉が大きく増加",
        priority: 4,
    
        optionType: "PUT",
        changeType: "increase",
    
        strike: nearbyPutIncrease.strike,
        diff: nearbyPutIncrease.diff,
    
        distance: Math.abs(
            nearbyPutIncrease.strike -
            numericCurrentPrice
        )
    });
}
else if (nearbyPutIncrease?.diff > 500) {
    bearishScore += 1;

    bearishReasons.push({
        text: "PUT建玉増加",
        priority: 3,
    
        optionType: "PUT",
        changeType: "increase",
    
        strike: nearbyPutIncrease.strike,
        diff: nearbyPutIncrease.diff,
    
        distance: Math.abs(
            nearbyPutIncrease.strike -
            numericCurrentPrice
        )
    });
}

if (nearbyPutIncrease?.diff > 500) {
    const putIncreaseDistanceScore =
        addDistanceScore(nearbyPutIncrease);

    bearishScore += putIncreaseDistanceScore;

    if (putIncreaseDistanceScore > 0) {
        bearishReasons.push({
            text: "現在値付近でPUT建玉が増加",
            priority: 5,

            optionType: "PUT",

    changeType: "increase",

    strike: nearbyPutIncrease.strike,

    diff: nearbyPutIncrease.diff,

    distance: Math.abs(

        nearbyPutIncrease.strike -

        numericCurrentPrice

    
        )});
    }
}

// CALL減少は下方向の材料
if (nearbyCallDecrease?.diff < -1000) {
    bearishScore += 2;

    bearishReasons.push({
        text: "CALL建玉が大きく減少",
        priority: 4,

        optionType: "CALL",
        changeType: "decrease",
        strike: nearbyCallDecrease.strike,
        diff: nearbyCallDecrease.diff,
        distance: Math.abs(
            nearbyCallDecrease.strike -
            numericCurrentPrice
        )
    });
}
else if (nearbyCallDecrease?.diff < 0) {
    bearishScore += 1;

    bearishReasons.push({
        text: "CALL建玉減少",
        priority: 3,
        
        optionType: "CALL",
        changeType: "decrease",
        strike: nearbyCallDecrease.strike,
        diff: nearbyCallDecrease.diff,
        distance: Math.abs(
            nearbyCallDecrease.strike -
            numericCurrentPrice
)
    });
}

if (nearbyCallDecrease?.diff < 0) {
    const callDecreaseDistanceScore =
        addDistanceScore(nearbyCallDecrease);

    bearishScore += callDecreaseDistanceScore;

    if (callDecreaseDistanceScore > 0) {
        bearishReasons.push({
            text: "現在値付近でCALL建玉が減少",
            priority: 5,
            optionType: "CALL",
            changeType: "decrease",
            strike: nearbyCallDecrease.strike,
            diff: nearbyCallDecrease.diff,
            distance: Math.abs(
                nearbyCallDecrease.strike -
                numericCurrentPrice
)
        });
    }
}


console.log(
    "CALL増加の距離点:",
    addDistanceScore(nearbyCallIncrease)
);

console.log(
    "PUT増加の距離点:",
    addDistanceScore(nearbyPutIncrease)
);

console.log(
    "PUT減少の距離点:",
    addDistanceScore(nearbyPutDecrease)
);

console.log(
    "CALL減少の距離点:",
    addDistanceScore(nearbyCallDecrease)
);


console.log("強気スコア:", bullishScore);
console.log("弱気スコア:", bearishScore);

let diagnosisReason = "CALL・PUTの勢力が拮抗しています。";
let marketAdvice =
    "• 方向感が出るまで、建玉の変化を観察しましょう。";



if (
    nearbyCallIncrease?.diff > 1000 &&
    nearbyPutDecrease?.diff < -1000
) {
    marketLevel = "強気";
    
    marketIcon = "🟢";
    diagnosisReason =
        "CALL増加とPUT減少が同時に確認され、上方向への期待が強まっています。";
    marketAdvice =
       "• 押し目を探しながら、上値での建玉変化にも注目しましょう。";    
}

else if (
    nearbyPutIncrease?.diff > 1000 &&
    nearbyCallDecrease?.diff < -1000
) {
    marketLevel = "弱気";
    
    marketIcon = "🔴";
    diagnosisReason =
    "PUT増加とCALL減少が同時に確認され、下方向への警戒が強まっています。";
    marketAdvice =
    "• 戻り売りが入りやすい場面か確認しながら、下値支持を見極めましょう。";
}

else if (
    nearbyCallIncrease?.diff > 500 &&
    nearbyPutDecrease?.diff < 0
) {
    marketLevel = "中立";
    marketIcon = "🟡";
    diagnosisReason =
        "強い上昇シグナルには届いていませんが、CALL増加とPUT減少が見られ、やや強気寄りです。";

    marketAdvice =
        "• 上方向への変化が続くか、次の建玉更新を確認しましょう。";
}
else if (
    nearbyPutIncrease?.diff > 500 &&
    nearbyCallDecrease?.diff < 0
) {
    marketLevel = "中立";
    marketIcon = "🟡";
    diagnosisReason =
        "強い下落シグナルには届いていませんが、PUT増加とCALL減少が見られ、やや弱気寄りです。";

    marketAdvice =
        "• 下方向への変化が続くか、次の建玉更新を確認しましょう。";
}

// ===== AI採点方式による市場診断 =====

const scoreDifference = bullishScore - bearishScore;

// 理由を優先度の高い順に並べる
const topBullishReasons = bullishReasons
    .filter(reason => reason && typeof reason === "object")
    .sort((a, b) => b.priority - a.priority)
    .slice(0, 3)
    .map(reason => reason.text);

const topBearishReasons = bearishReasons
    .filter(reason => reason && typeof reason === "object")
    .sort((a, b) => b.priority - a.priority)
    .slice(0, 3)
    .map(reason => reason.text);

if (scoreDifference >= 5) {
    marketLevel = "強気";
    marketIcon = "🟢";

    diagnosisReason =
        topBullishReasons.length > 0
            ? topBullishReasons.join("・")
            : `強気材料が弱気材料を${scoreDifference}点上回っています。`;

    marketAdvice =
        "• 押し目を探しながら、上方向への変化が続くか確認しましょう。";
}
else if (scoreDifference >= 2) {
    marketLevel = "やや強気";
    marketIcon = "🟢";

    diagnosisReason =
        topBullishReasons.length > 0
            ? topBullishReasons.join("・")
            : `強気材料がやや優勢です。（+${scoreDifference}点）`;

    marketAdvice =
        "• 上方向への変化が続くか、次の建玉更新を確認しましょう。";
}
else if (scoreDifference <= -5) {
    marketLevel = "弱気";
    marketIcon = "🔴";

    diagnosisReason =
        topBearishReasons.length > 0
            ? topBearishReasons.join("・")
            : `弱気材料が強気材料を${Math.abs(scoreDifference)}点上回っています。`;

    marketAdvice =
        "• 戻り売りが入りやすい場面か確認しながら、下値支持を見極めましょう。";
}
else if (scoreDifference <= -2) {
    marketLevel = "やや弱気";
    marketIcon = "🔴";

    diagnosisReason =
        topBearishReasons.length > 0
            ? topBearishReasons.join("・")
            : `弱気材料がやや優勢です。（${scoreDifference}点）`;

    marketAdvice =
        "• 下方向への変化が続くか、次の建玉更新を確認しましょう。";
}
else{
    marketLevel = "中立";
    marketIcon = "🟡";
    diagnosisReason =
        "強気・弱気材料がほぼ拮抗しています。";

    marketAdvice =
        "• 方向感が出るまで、建玉の変化を観察しましょう。";
}

let selectedDiagnosisReasons = [];

if (marketLevel.includes("強気")) {
    selectedDiagnosisReasons = bullishReasons;
}
else if (marketLevel.includes("弱気")) {
    selectedDiagnosisReasons = bearishReasons;
}
else {
    selectedDiagnosisReasons = [
        ...bullishReasons,
        ...bearishReasons
    ];
}

diagnosisReason = createDiagnosisSentence(
    selectedDiagnosisReasons,
    marketLevel
);

const aiComment = createAIComment(
    bullishReasons,
    bearishReasons,
    marketLevel,
    latestFutureOpenInterestResult
);

const summary = [];

let badgeClass = "neutral";

if (marketLevel === "強気") {
    badgeClass = "strong";
}
else if (marketLevel === "弱気") {
    badgeClass = "weak";
}

summary.unshift(
    `<span class="market-badge ${badgeClass}">
        ${marketIcon} 市場診断：${marketLevel}
     </span>`
);
summary.splice(
    1,
    0,
    `　理由：${diagnosisReason}`
);

summary.splice(
    2,
    0,
    `<span class="ai-comment">AIコメント：${aiComment}</span>`
);


const diagnosisHtml = `
<div class="market-diagnosis ${marketLevel}">
    <div class="title">${marketIcon} 市場診断</div>
    <div class="level">${marketLevel}</div>
</div>
`;

const sameStrikeCandidate =
    nearbyCallIncrease?.strike != null &&
    nearbyPutIncrease?.strike != null &&
    nearbyCallIncrease.strike === nearbyPutIncrease.strike
        ? nearbyCallIncrease.strike
        : null;

        const confidenceCandidates = [
            nearbyCallIncrease,
            nearbyCallDecrease,
            nearbyPutIncrease,
            nearbyPutDecrease
        ].filter(item => item?.strike != null);
        
        const strongestDifference =
            confidenceCandidates.length > 0
                ? Math.max(
                    ...confidenceCandidates.map(
                        item => Math.abs(item.diff ?? 0)
                    )
                )
                : 0;
        
        const nearestDistance =
            confidenceCandidates.length > 0
                ? Math.min(
                    ...confidenceCandidates.map(
                        item =>
                            Math.abs(
                                item.strike - numericCurrentPrice
                            )
                    )
                )
                : Infinity;
        
        // 強気または弱気まで方向が出ている
        if (marketLevel !== "中立") {
            confidenceScore += 1;
        }
        
        // CALLとPUTが同じ価格帯で一致している
        if (sameStrikeCandidate != null) {
            confidenceScore += 1;
        }
        
        // 1,000枚以上の大きな変化がある
        if (strongestDifference >= 1000) {
            confidenceScore += 1;
        }
        
        // 現在値から500円以内に注目変化がある
        if (nearestDistance <= 500) {
            confidenceScore += 1;
        }
        
        confidenceScore =
            Math.min(5, confidenceScore);
        
        confidence =
            "★".repeat(confidenceScore) +
            "☆".repeat(5 - confidenceScore);
            let confidenceReason = "";
            if (confidenceScore >= 5) {
                confidenceReason =
                    "複数の重要シグナルが一致し、高い信頼性があります。";
            } else if (confidenceScore === 4) {
                confidenceReason =
                    "複数の条件が揃い、信頼性は高めです。";
            } else if (confidenceScore === 3) {
                confidenceReason =
                    "いくつかの条件が揃っていますが、慎重な判断も必要です。";
            } else if (confidenceScore === 2) {
                confidenceReason =
                    "根拠はありますが、まだ方向感は十分ではありません。";
            } else {
                confidenceReason =
                    "判断材料が少なく、様子見が無難です。";
            }

       // 星を計算したあとで表示に追加

         summary.splice( 
             2,
             0,
             `<span class="confidence-badge">⭐ 信頼度：${confidence}</span>`
);     
         summary.splice(
             3,
             0,
             `　理由：${confidenceReason}`
);
        summary.splice(
             4,
             0,
             `<span class="point-badge">💡 注目ポイント</span>`
);

         summary.splice(
             5,
             0,
);

         summary.splice(
             6,
             0,
             `${marketAdvice}`
);    




if (sameStrikeCandidate != null) {
    summary.push(
        `• CALL・PUTともに ${sameStrikeCandidate.toLocaleString()}円で建玉増加が確認されています。`
    );
    summary.push(
        `• ${sameStrikeCandidate.toLocaleString()}円付近が重要価格帯として意識されている可能性があります。`
    );
}

if (
    sameStrikeCandidate == null &&
    nearbyCallIncrease?.strike != null
) {
    summary.push(
        `• 現在値付近では ${nearbyCallIncrease.strike.toLocaleString()}円CALLの建玉増加が目立ちます。`
    );
}
if (nearbyPutDecrease?.strike != null) {
    summary.push(
        `• ${nearbyPutDecrease.strike.toLocaleString()}円PUTでは建玉減少が確認されています。`
    );
}

const nearbyCandidates = [
    nearbyCallIncrease,
    nearbyCallDecrease,
    nearbyPutIncrease,
    nearbyPutDecrease
].filter(item => item?.strike != null);

if (nearbyCandidates.length > 0) {
    const nearestItem = nearbyCandidates
        .slice()
        .sort(
            (a, b) =>
                Math.abs(a.strike - numericCurrentPrice) -
                Math.abs(b.strike - numericCurrentPrice)
        )[0];

        summary.push(
            `• 現在値に最も近い注目価格帯は ${nearestItem.strike.toLocaleString()}円です。`
        );
}

const marketSummaryElement =
    document.getElementById("marketSummary");

if (marketSummaryElement) {
    marketSummaryElement.innerHTML =
        summary.length > 0
            ? summary.join("<br>")
            : "現在値付近に該当する変化はありません。";
}
}


// 初期表示
renderSavedSnapshots();

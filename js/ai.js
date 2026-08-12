

function analyzeOptionMapData(aiData) {

    console.log("ai.jsで受け取ったデータ:", aiData);

    const summary = {
        priceLevels: aiData.labels.length,
        hasNightData: aiData.nightData.length > 0,
        hasDayData: aiData.dayData.length > 0,
        hasOptionData: aiData.optionData.length > 0
    };
    
    console.log("AIデータ概要:", summary);

    const futureOpenInterestText = aiData.futureOpenInterest
    ? JSON.stringify(aiData.futureOpenInterest, null, 2)
    : "データなし";

    let prompt = `
   【現在値】
    ${aiData.currentPrice} 円

   【価格帯】
    価格帯データ：${aiData.labels.length} 本

   【夜間手口】
    ${aiData.nightData}

   【日中手口】
    ${aiData.dayData}

   【オプション建玉】
    ${aiData.optionData}

   【指数先物建玉（週次）】
    ${futureOpenInterestText}
`;
        
    prompt += `

【分析してほしいこと】

・今日の市場全体の特徴
・現在値に近い重要価格帯
・CALL壁・PUT壁の候補
・建玉の偏りから考えられる動き

・週次の指数先物建玉について、買い建玉上位・売り建玉上位を必ず具体名と枚数付きでコメントしてください。
・日中・夜間の取引高と週次建玉が同じ方向か、逆方向かを比較してください。
・ラージ・ミニ・TOPIXで傾向が異なる場合は、その違いも説明してください。

・参加者別手口から読み取れる特徴
・初心者にも分かるように説明してください。
・週次の指数先物建玉は必ず分析してください。
・参加者ごとの買い建玉・売り建玉の偏りと、日中・夜間の取引高との一致・不一致をコメントしてください。

・回答には「週次指数先物建玉」という見出しを必ず含めてください。
`;

console.log(prompt);

    return "✅ ai.jsにつながりました！";
}

window.analyzeOptionMapData = analyzeOptionMapData;
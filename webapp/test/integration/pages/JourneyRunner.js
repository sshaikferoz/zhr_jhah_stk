sap.ui.define([
    "sap/fe/test/JourneyRunner",
	"com/jhah/zhrjhahsecstk/test/integration/pages/StickerMasterList.gen",
	"com/jhah/zhrjhahsecstk/test/integration/pages/StickerMasterObjectPage.gen"
], function (JourneyRunner, StickerMasterListGenerated, StickerMasterObjectPageGenerated) {
    'use strict';

    var runner = new JourneyRunner({
        launchUrl: sap.ui.require.toUrl('com/jhah/zhrjhahsecstk') + '/test/flp.html#app-preview',
        pages: {
			onTheStickerMasterListGenerated: StickerMasterListGenerated,
			onTheStickerMasterObjectPageGenerated: StickerMasterObjectPageGenerated
        },
        async: true
    });

    return runner;
});


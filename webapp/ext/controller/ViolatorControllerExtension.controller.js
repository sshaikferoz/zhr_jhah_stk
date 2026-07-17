sap.ui.define([
    "sap/ui/core/mvc/ControllerExtension",
    "sap/ui/model/json/JSONModel"
], function (ControllerExtension, JSONModel) {
    "use strict";

    return ControllerExtension.extend("com.jhah.zhrjhahsecstk.ext.controller.ViolatorControllerExtension", {

        override: {
            onInit: function () {
                var oView = this.base.getView();

                try {
                    // Safe model initialization
                    var oViolatorModel = new JSONModel({ isVisible: false });
                    oView.setModel(oViolatorModel, "violator");

                    // Style hook used by css/style.css to scope the strip
                    oView.addStyleClass("zhrjhahsecstk-app");
                    document.body.classList.add("zhrjhahsecstk-app");

                    // Hide the "Copy Request" action by default; it is revealed
                    // only for Sticker admins once the auth check confirms it.
                    this._applyCopyRequestVisibility();
                } catch (err) {
                    console.error("Error in ViolatorControllerExtension onInit:", err);
                }
            },

            routing: {
                onAfterBinding: function (oBindingContext) {
                    var oView = this.base.getView();
                    var oAppModel = oView.getModel();

                    if (!oAppModel) return;

                    var oViolatorModel = oView.getModel("violator");
                    if (!oViolatorModel) {
                        oViolatorModel = new JSONModel({ isVisible: false });
                        oView.setModel(oViolatorModel, "violator");
                    }

                    // Only act on the Sticker Master object page context
                    if (oBindingContext && oBindingContext.getPath().indexOf("/StickerMaster") !== -1) {
                        oBindingContext.requestProperty("JhahId").then(function (sJhahId) {

                            if (sJhahId && sJhahId.trim() !== "") {
                                var sPath = "/EmployeeDetails('" + sJhahId + "')";

                                var oContext = oAppModel.bindContext(sPath, null, {
                                    "$$groupId": "$direct"
                                });

                                oContext.requestObject().then(function (oData) {
                                    if (oData && oViolatorModel) {
                                        oViolatorModel.setData(Object.assign({}, oData, { isVisible: true }));
                                    }
                                }).catch(function (err) {
                                    console.error("Failed to fetch employee details:", err);
                                    if (oViolatorModel) oViolatorModel.setData({ isVisible: false });
                                });
                            } else {
                                if (oViolatorModel) oViolatorModel.setData({ isVisible: false });
                            }
                        }).catch(function (err) {
                            console.error("Failed to read JhahId property:", err);
                            if (oViolatorModel) oViolatorModel.setData({ isVisible: false });
                        });
                    }
                }
            }
        },

        /**
         * Toggle visibility of the "Copy Request" action based on the logged-in
         * user's Sticker-admin flag. The flag lives on the VAR service's
         * EmployeeHeader entity (StickerAdmin = "X" for admins), exposed here via
         * the "varAuth" model. The button is hidden by default so non-admins never
         * see it flash in, and is only shown once StickerAdmin is confirmed as "X".
         */
        _applyCopyRequestVisibility: function () {
            // Hidden by default until proven admin.
            document.body.classList.add("hideCopyRequest");

            var oView = this.base.getView();
            var oVarModel = oView && oView.getModel("varAuth");
            if (!oVarModel) {
                console.error("varAuth model not available for Sticker admin check.");
                return;
            }

            try {
                var oListBinding = oVarModel.bindList("/EmployeeHeader", null, null, null, { $$groupId: "$direct" });
                oListBinding.requestContexts(0, 1).then(function (aContexts) {
                    var bIsStickerAdmin = false;
                    if (aContexts && aContexts.length > 0) {
                        var oUserData = aContexts[0].getObject();
                        bIsStickerAdmin = oUserData && oUserData.StickerAdmin === "X";
                    }
                    if (bIsStickerAdmin) {
                        document.body.classList.remove("hideCopyRequest");
                    } else {
                        document.body.classList.add("hideCopyRequest");
                    }
                }).catch(function (err) {
                    console.error("Sticker admin check fetch failed:", err);
                    // Keep it hidden on failure (safe default).
                });
            } catch (err) {
                console.error("Error running Sticker admin check:", err);
            }
        }
    });
});

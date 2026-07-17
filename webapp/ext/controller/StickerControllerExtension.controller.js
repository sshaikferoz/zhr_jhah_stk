sap.ui.define([
    "sap/ui/core/mvc/ControllerExtension",
    "sap/ui/model/json/JSONModel"
], function (ControllerExtension, JSONModel) {
    "use strict";

    // "HH:MM:SS" (Edm.TimeOfDay) -> "H:MM AM/PM" for slot dropdown labels only.
    // The raw value is kept for saving.
    function formatTime12h(sTime) {
        if (!sTime) {
            return "";
        }
        var aParts = String(sTime).split(":");
        var iHour = parseInt(aParts[0], 10);
        var sMin = aParts[1] || "00";
        if (isNaN(iHour)) {
            return String(sTime);
        }
        var sMeridiem = iHour >= 12 ? "PM" : "AM";
        var iHour12 = iHour % 12;
        if (iHour12 === 0) {
            iHour12 = 12;
        }
        return iHour12 + ":" + sMin + " " + sMeridiem;
    }

    return ControllerExtension.extend("com.jhah.zhrjhahsecstk.ext.controller.StickerControllerExtension", {

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
                    console.error("Error in StickerControllerExtension onInit:", err);
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

                        // Build the appointment-slot picker data.
                        this._loadAppointmentSlots(oView, oAppModel, oBindingContext);

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
         * Fetch every appointment slot and expose it through the "apptslots" JSON
         * model used by the custom Appointment Slot section. Groups slots by date,
         * derives the DatePicker min/max range, and seeds the time dropdown with the
         * slots for the currently selected date.
         */
        _loadAppointmentSlots: function (oView, oAppModel, oBindingContext) {
            var oSlotModel = oView.getModel("apptslots");
            if (!oSlotModel) {
                oSlotModel = new JSONModel({
                    dates: [], slotsByDate: {}, minDate: null, maxDate: null, currentSlots: []
                });
                oView.setModel(oSlotModel, "apptslots");
            }

            var oSlotBinding = oAppModel.bindList("/AppointmentSlot", null, null, null, { $$groupId: "$direct" });
            Promise.all([
                oSlotBinding.requestContexts(0, 1000),
                oBindingContext.requestProperty("AppointmentDate")
            ]).then(function (aResult) {
                var aContexts = aResult[0] || [];
                var sCurrentDate = aResult[1];

                var mByDate = {};
                var aDates = [];
                aContexts.forEach(function (oCtx) {
                    var oSlot = oCtx.getObject();
                    var sDate = oSlot.AppointmentDate;
                    if (!sDate) { return; }
                    if (!mByDate[sDate]) {
                        mByDate[sDate] = [];
                        aDates.push(sDate);
                    }
                    mByDate[sDate].push({
                        SlotId: oSlot.SlotId,
                        FromTime: oSlot.FromTime,
                        ToTime: oSlot.ToTime,
                        label: formatTime12h(oSlot.FromTime) + " - " + formatTime12h(oSlot.ToTime)
                    });
                });
                aDates.sort();

                oSlotModel.setData({
                    dates: aDates,
                    slotsByDate: mByDate,
                    minDate: aDates.length ? new Date(aDates[0] + "T00:00:00") : null,
                    maxDate: aDates.length ? new Date(aDates[aDates.length - 1] + "T00:00:00") : null,
                    currentSlots: (sCurrentDate && mByDate[sCurrentDate]) || []
                });
            }).catch(function (err) {
                console.error("Failed to load appointment slots:", err);
            });
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

            // During onInit the view isn't connected to the component tree yet,
            // so named component models aren't propagated to it. Read the model
            // from the app component, which owns it, and fall back to the view.
            var oView = this.base.getView();
            var oComponent = (typeof this.base.getAppComponent === "function") ? this.base.getAppComponent() : null;
            var oVarModel = (oComponent && oComponent.getModel("varAuth")) || (oView && oView.getModel("varAuth"));
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

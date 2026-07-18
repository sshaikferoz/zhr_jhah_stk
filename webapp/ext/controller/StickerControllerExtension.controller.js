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

    // Locate the time-slot ComboBox that sits next to the given DatePicker so we
    // can hard-reset its selection when the date changes.
    function findSlotComboBox(oControl) {
        var oNode = oControl;
        while (oNode && !(oNode.isA && oNode.isA("sap.ui.core.mvc.View"))) {
            oNode = oNode.getParent();
        }
        if (!oNode) {
            return null;
        }
        var aFound = oNode.findAggregatedObjects(true, function (o) {
            return o.isA && o.isA("sap.m.ComboBox") &&
                o.getId().indexOf("appointmentSlotSelect") !== -1;
        });
        return aFound && aFound[0];
    }

    // FromTime/ToTime (and HideApp) are computed on the backend from the chosen
    // slot. Writing via Context#setProperty bypasses the FE field wiring, so the
    // metadata side effects never fire — request them explicitly so the computed
    // fields refresh. Queued in the same $auto batch as the patches.
    function requestAppointmentSideEffects(oContext) {
        oContext.requestSideEffects([
            "FromTime", "ToTime", "HideApp", "AppointmentFromTime", "AppointmentToTime"
        ]).catch(function (err) {
            console.error("Failed to refresh appointment side effects:", err);
        });
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
                        // this._loadAppointmentSlots(oView, oAppModel, oBindingContext);

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
         * Fired when the user picks an appointment date (invoked from
         * AppointmentSlots.fragment.xml via the .extension handler syntax).
         * Refreshes the time-slot dropdown to the slots for that date and clears
         * any previous slot pick, or flags an error if the date has no slots.
         */
        onAppointmentDateChange: function (oEvent) {
            var oDatePicker = oEvent.getSource();
            var bValid = oEvent.getParameter("valid");
            var oContext = oDatePicker.getBindingContext();
            var oSlotModel = oDatePicker.getModel("apptslots");
            if (!oContext || !oSlotModel) {
                return;
            }

            // AppointmentDate has already been written to the context by two-way binding.
            var sDate = oContext.getProperty("AppointmentDate"); // "yyyy-MM-dd"
            var mByDate = oSlotModel.getProperty("/slotsByDate") || {};
            var aSlots = (sDate && mByDate[sDate]) || [];

            oSlotModel.setProperty("/currentSlots", aSlots);

            // Reset the previously chosen slot whenever the date changes.
            oContext.setProperty("SlotId", "");
            oContext.setProperty("AppointmentFromTime", null);
            oContext.setProperty("AppointmentToTime", null);
            requestAppointmentSideEffects(oContext);

            // Hard-reset the dropdown control so no stale slot text lingers.
            var oCombo = findSlotComboBox(oDatePicker);
            if (oCombo) {
                oCombo.setSelectedKey("");
                oCombo.setSelectedItem(null);
                oCombo.setValue("");
            }

            if (!bValid || (sDate && aSlots.length === 0)) {
                oDatePicker.setValueState("Error");
                oDatePicker.setValueStateText("Please select an available appointment date.");
            } else {
                oDatePicker.setValueState("None");
                oDatePicker.setValueStateText("");
            }
        },

        /**
         * Fired when the user picks a time slot (invoked from
         * AppointmentSlots.fragment.xml via the .extension handler syntax).
         * Writes the slot's times and id back to the Sticker Master entity.
         */
        onAppointmentSlotChange: function (oEvent) {
            var oComboBox = oEvent.getSource();
            var oItem = oEvent.getParameter("selectedItem");
            var oContext = oComboBox.getBindingContext();
            var oSlotModel = oComboBox.getModel("apptslots");
            if (!oContext || !oSlotModel) {
                return;
            }

            if (!oItem) {
                oContext.setProperty("SlotId", "");
                oContext.setProperty("AppointmentFromTime", null);
                oContext.setProperty("AppointmentToTime", null);
                requestAppointmentSideEffects(oContext);
                return;
            }

            var sSlotId = oItem.getKey();
            var aSlots = oSlotModel.getProperty("/currentSlots") || [];
            var oSlot = aSlots.filter(function (s) {
                return s.SlotId === sSlotId;
            })[0];
            if (!oSlot) {
                return;
            }

            oContext.setProperty("SlotId", oSlot.SlotId);
            oContext.setProperty("AppointmentFromTime", oSlot.FromTime);
            oContext.setProperty("AppointmentToTime", oSlot.ToTime);
            requestAppointmentSideEffects(oContext);
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

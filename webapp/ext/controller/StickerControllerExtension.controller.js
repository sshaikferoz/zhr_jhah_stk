sap.ui.define([
    "sap/ui/core/mvc/ControllerExtension",
    "sap/ui/core/Fragment",
    "sap/ui/core/format/DateFormat",
    "sap/ui/base/Event",
    "sap/ui/model/Filter",
    "sap/ui/model/FilterOperator",
    "sap/ui/model/json/JSONModel",
    "sap/m/MessageBox",
    "com/jhah/zhrjhahsecstk/ext/util/SlotTimeFormat"
], function (ControllerExtension, Fragment, DateFormat, Event, Filter, FilterOperator, JSONModel, MessageBox, SlotTimeFormat) {
    "use strict";

    var formatTime12h = SlotTimeFormat.formatTime12h;

    var MS_PER_HOUR = 60 * 60 * 1000;
    var MS_PER_DAY = 24 * MS_PER_HOUR;

    var APPOINTMENT_CUTOFF_HOURS = 24;
    var RENEW_WINDOW_DAYS = 30;

    var MAX_ACTIVE_STICKERS = 2;
    var ISSUED_CRITICALITY = 3;

    var GUARD_FLAG = "zhrActionGuarded";

    var APPOINTMENT_PROPERTIES = ["AppointmentDate", "AppointmentFromTime"];
    var RENEW_PROPERTIES = ["ExpireDate"];

    var oDateFormat = DateFormat.getDateInstance({ style: "medium" });
    var oEdmDateFormat = DateFormat.getDateInstance({ pattern: "yyyy-MM-dd", calendarType: "Gregorian" });

    function formatDate(oDate) {
        return oDate ? oDateFormat.format(oDate) : "";
    }

    function toLocalDate(sDate, sTime) {
        if (!sDate) { return null; }
        var oDate = new Date(sDate + "T" + (sTime || "00:00:00"));
        return isNaN(oDate.getTime()) ? null : oDate;
    }

    function startOfToday() {
        var oToday = new Date();
        oToday.setHours(0, 0, 0, 0);
        return oToday;
    }

    function addDays(oDate, iDays) {
        var oResult = new Date(oDate.getTime());
        oResult.setDate(oResult.getDate() + iDays);
        return oResult;
    }

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
                    var oViolatorModel = new JSONModel({ isVisible: false });
                    oView.setModel(oViolatorModel, "violator");

                    oView.addStyleClass("zhrjhahsecstk-app");
                    document.body.classList.add("zhrjhahsecstk-app");

                    this._applyMaintenanceActionVisibility();
                } catch (err) {
                    console.error("Error in StickerControllerExtension onInit:", err);
                }
            },

            routing: {
                onAfterBinding: function (oBindingContext) {
                    var oView = this.base.getView();
                    var oAppModel = oView.getModel();

                    this._markAppointmentFieldsMandatory();
                    this._markAttachmentsMandatory();
                    this._applyUIEnhancements();

                    try {
                        this._applyActionGuards();
                    } catch (err) {
                        console.error("Failed to apply action guards:", err);
                    }

                    if (!oAppModel) return;

                    var oViolatorModel = oView.getModel("violator");
                    if (!oViolatorModel) {
                        oViolatorModel = new JSONModel({ isVisible: false });
                        oView.setModel(oViolatorModel, "violator");
                    }

                    if (oBindingContext && oBindingContext.getPath().indexOf("/StickerMaster") !== -1) {

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
        _applyUIEnhancements: function () {

            var oExtension = this;
            var oView = this.base.getView();

            var $view = oView.$();

            /*
             * View DOM is not ready yet.
             * Retry until the view has been rendered.
             */
            if (!$view || $view.length === 0) {

                setTimeout(function () {
                    oExtension._applyUIEnhancements();
                }, 200);

                return;
            }


            /*
             * Function responsible for changing:
             *
             * Create -> Submit
             *
             * ONLY for:
             *
             * 1. Footer Create button
             * 2. Evidence table StandardAction::Create button
             */
            var fnChangeCreateToSubmit = function () {

                try {

                    var $currentView = oView.$();

                    if (!$currentView || $currentView.length === 0) {
                        return;
                    }


                    /*
                     * ---------------------------------------------------------
                     * 1. EXACT EVIDENCE TABLE CREATE BUTTON
                     * ---------------------------------------------------------
                     *
                     * Example runtime ID:
                     *
                     * com.jhah.zhrjhahsecstk::StickerMasterObjectPage
                     * --fe::table::_Evidence::LineItem::StandardAction::Create
                     */
                    var sCreateButtonId =
                        "com.jhah.zhrjhahsecstk::StickerMasterObjectPage--" +
                        "fe::table::_Evidence::LineItem::StandardAction::Create";


                    var oCreateButton = sap.ui.getCore().byId(sCreateButtonId);


                    if (oCreateButton &&
                        typeof oCreateButton.getText === "function") {

                        var sCreateText =
                            String(oCreateButton.getText() || "").trim();

                        if (sCreateText.toUpperCase() === "CREATE") {

                            if (oCreateButton.getText() !== "Submit") {

                                oCreateButton.setText("Add Attachment");

                                console.log(
                                    "Evidence Create button changed to Submit:",
                                    sCreateButtonId
                                );
                            }
                        }
                    }


                    /*
                     * ---------------------------------------------------------
                     * 2. FOOTER CREATE BUTTON
                     * ---------------------------------------------------------
                     *
                     * This keeps your existing Create -> Submit logic.
                     */
                    $currentView.find(".sapMBtn").each(function () {

                        var oBtn = sap.ui.core.Element.closestTo(this);

                        if (!oBtn ||
                            typeof oBtn.getText !== "function") {
                            return;
                        }


                        var sText =
                            String(oBtn.getText() || "").trim();


                        /*
                         * Only process Create buttons.
                         */
                        if (sText.toUpperCase() !== "CREATE") {
                            return;
                        }


                        /*
                         * Check whether the button belongs to
                         * the Fiori Elements footer.
                         */
                        var $footer = $(this).closest(
                            ".sapMFooter-CTX, " +
                            ".sapFDynamicPageFooter, " +
                            ".sapMPageFooter, " +
                            "footer"
                        );


                        if ($footer.length > 0) {

                            /*
                             * Change only the visible text.
                             *
                             * Original Fiori Elements action remains intact.
                             */
                            if (oBtn.getText() !== "Submit") {

                                oBtn.setText("Submit");

                                console.log(
                                    "Footer Create button changed to Submit:",
                                    oBtn.getId()
                                );
                            }
                        }

                    });

                } catch (e) {

                    console.error(
                        "Error while changing Create button to Submit:",
                        e
                    );
                }
            };


            /*
             * ---------------------------------------------------------
             * Execute immediately
             * ---------------------------------------------------------
             */
            fnChangeCreateToSubmit();


            /*
             * ---------------------------------------------------------
             * Execute again after delays
             *
             * Fiori Elements may create the button asynchronously.
             * ---------------------------------------------------------
             */
            setTimeout(fnChangeCreateToSubmit, 100);
            setTimeout(fnChangeCreateToSubmit, 300);
            setTimeout(fnChangeCreateToSubmit, 600);
            setTimeout(fnChangeCreateToSubmit, 1000);


            /*
             * ---------------------------------------------------------
             * MutationObserver
             *
             * Fiori Elements can recreate controls after:
             *
             * Create -> Edit
             * Edit -> Display
             * Draft changes
             * Table refresh
             * Navigation
             * ---------------------------------------------------------
             */
            if (!$view.data("createToSubmitObserverAttached")) {

                var domView = $view[0];

                if (domView) {

                    var oObserver = new MutationObserver(function () {

                        fnChangeCreateToSubmit();

                    });


                    oObserver.observe(domView, {

                        childList: true,
                        subtree: true

                    });


                    /*
                     * Store observer so it is not attached repeatedly.
                     */
                    $view.data(
                        "createToSubmitObserverAttached",
                        true
                    );

                    $view.data(
                        "createToSubmitObserver",
                        oObserver
                    );
                }
            }
        },
        
        _markAppointmentFieldsMandatory: function () {
            var oView = this.base.getView();

            var aFieldIds = [
                "fe::FormContainer::VehicleSpecFacet::FormElement::DataField::PlateTyp-label",
                "fe::FormContainer::VehicleSpecFacet::FormElement::DataField::PlateNum-label",
                "fe::FormContainer::VehicleSpecFacet::FormElement::DataField::Manufacturer-label",
                "fe::FormContainer::VehicleSpecFacet::FormElement::DataField::Color-label",
                "fe::FormContainer::VehicleSpecFacet::FormElement::DataField::PlateNum1-label",
                "fe::FormContainer::VehicleSpecFacet::FormElement::DataField::PlateNum2-label",
                "fe::FormContainer::VehicleSpecFacet::FormElement::DataField::PlateNum3-label",
                "fe::FormContainer::AppointSpecFacet::CustomFormElement::AppointmentDatePicker-label",
                "fe::FormContainer::AppointSpecFacet::CustomFormElement::TimeSlotSelect-label",
                "fe::FormContainer::AppointSpecFacet::FormElement::DataField::AppointmentLocation-label"
            ];

            aFieldIds.forEach(function (sFieldId) {
                var oLabel = oView.byId(sFieldId);

                if (oLabel) {
                    oLabel.setRequired(true);
                }
            });
        },
        _markAttachmentsMandatory: function () {
            var oView = this.base.getView();

            var oTitle = oView.byId("fe::table::_Evidence::LineItem-title");

            if (oTitle) {
                oTitle.addStyleClass("zhrAttachmentsMandatory");
            }
        },

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
                oBindingContext.requestProperty("AppointmentDate"),
                oBindingContext.requestProperty("AppointmentFromTime"),
                oBindingContext.requestProperty("SlotId"),
                oBindingContext.requestProperty("AppointmentToTime")
            ]).then(function (aResult) {
                var aContexts = aResult[0] || [];
                var sCurrentDate = aResult[1];
                var sCurrentTime = aResult[2];
                var sCurrentSlotId = aResult[3];
                var sCurrentToTime = aResult[4];

                var mByDate = {};
                var aDates = [];
                var mSeen = {};
                aContexts.forEach(function (oCtx) {
                    var oSlot = oCtx.getObject();
                    var sDate = oSlot.AppointmentDate;
                    if (!sDate) { return; }
                    var sSeenKey = sDate + "#" + oSlot.SlotId + "#" + oSlot.FromTime;
                    if (mSeen[sSeenKey]) { return; }
                    mSeen[sSeenKey] = true;
                    if (!mByDate[sDate]) {
                        mByDate[sDate] = [];
                        aDates.push(sDate);
                    }
                    var bFull = oSlot.Capacity > 0 && oSlot.Booked >= oSlot.Capacity;
                    var sRange = formatTime12h(oSlot.FromTime) + " - " + formatTime12h(oSlot.ToTime);
                    mByDate[sDate].push({
                        key: oSlot.SlotId + "#" + oSlot.FromTime,
                        SlotId: oSlot.SlotId,
                        FromTime: oSlot.FromTime,
                        ToTime: oSlot.ToTime,
                        full: bFull,
                        rangeLabel: sRange,
                        label: sRange + (bFull ? " (fully booked)" : "")
                    });
                });
                aDates.sort();
                Object.keys(mByDate).forEach(function (sKey) {
                    mByDate[sKey].sort(function (a, b) {
                        return a.FromTime < b.FromTime ? -1 : (a.FromTime > b.FromTime ? 1 : 0);
                    });
                });

                oSlotModel.setData({
                    dates: aDates,
                    slotsByDate: mByDate,
                    minDate: aDates.length ? new Date(aDates[0] + "T00:00:00") : null,
                    maxDate: aDates.length ? new Date(aDates[aDates.length - 1] + "T00:00:00") : null,
                    currentSlots: (sCurrentDate && mByDate[sCurrentDate]) || []
                });
                oSlotModel.setProperty(
                    "/selectedKey",
                    sCurrentSlotId + "#" + sCurrentTime
                );
                oSlotModel.setProperty(
                    "/selectedLabel",
                    sCurrentSlotId
                        ? formatTime12h(sCurrentTime) + " - " + formatTime12h(sCurrentToTime)
                        : ""
                );

            }).catch(function (err) {
                console.error("Failed to load appointment slots:", err);
            });
        },

        onAppointmentDateChange: function (oEvent) {
            var oDatePicker = oEvent.getSource();
            var bValid = oEvent.getParameter("valid");
            var oContext = oDatePicker.getBindingContext();
            var oSlotModel = oDatePicker.getModel("apptslots");
            if (!oContext || !oSlotModel) {
                return;
            }

            var sDate = oContext.getProperty("AppointmentDate");
            var mByDate = oSlotModel.getProperty("/slotsByDate") || {};
            var aSlots = (sDate && mByDate[sDate]) || [];

            oSlotModel.setProperty("/currentSlots", aSlots);

            oSlotModel.setProperty("/selectedKey", "");
            oSlotModel.setProperty("/selectedLabel", "");
            oContext.setProperty("SlotId", "");
            oContext.setProperty("AppointmentFromTime", "00:00:00");
            oContext.setProperty("AppointmentToTime", "00:00:00");
            requestAppointmentSideEffects(oContext);

            if (!bValid || (sDate && aSlots.length === 0)) {
                oDatePicker.setValueState("Error");
                oDatePicker.setValueStateText("Please select an available appointment date.");
            } else {
                oDatePicker.setValueState("None");
                oDatePicker.setValueStateText("");
            }
        },

        onAppointmentSlotValueHelp: function (oEvent) {
            var oInput = oEvent.getSource();
            var oView = this.base.getView();

            if (!this._pSlotPopover) {
                this._pSlotPopover = Fragment.load({
                    id: oView.getId() + "--slotPopover",
                    name: "com.jhah.zhrjhahsecstk.ext.fragment.TimeSlotPopover",
                    controller: this
                }).then(function (oPopover) {
                    oView.addDependent(oPopover);
                    return oPopover;
                });
            }
            this._pSlotPopover.then(function (oPopover) {
                oPopover.openBy(oInput);
            });
        },

        onAppointmentSlotPopoverCancel: function () {
            if (this._pSlotPopover) {
                this._pSlotPopover.then(function (oPopover) {
                    oPopover.close();
                });
            }
        },

        onAppointmentSlotPress: function (oEvent) {
            var oButton = oEvent.getSource();
            var oView = this.base.getView();
            var oContext = oButton.getBindingContext() || oView.getBindingContext();
            var oSlotModel = oView.getModel("apptslots");
            if (!oContext || !oSlotModel) {
                return;
            }

            var oItemContext = oButton.getBindingContext("apptslots");
            var oSlot = oItemContext && oItemContext.getObject();
            if (!oSlot) {
                return;
            }

            oSlotModel.setProperty("/selectedKey", oSlot.key);
            oSlotModel.setProperty("/selectedLabel", oSlot.rangeLabel);
            oContext.setProperty("SlotId", oSlot.SlotId);
            oContext.setProperty("AppointmentFromTime", oSlot.FromTime);
            oContext.setProperty("AppointmentToTime", oSlot.ToTime);
            requestAppointmentSideEffects(oContext);

            this.onAppointmentSlotPopoverCancel();
        },

        _requestActiveStickerCount: function () {
            var oModel = this.base.getView().getModel();
            if (!oModel) {
                return Promise.reject(new Error("Main OData model not available."));
            }

            var aFilters = [
                new Filter("StatsCriticality", FilterOperator.EQ, ISSUED_CRITICALITY),
                new Filter("ExpireDate", FilterOperator.GT, oEdmDateFormat.format(startOfToday())),
                new Filter("IsActiveEntity", FilterOperator.EQ, true)
            ];

            var oBinding = oModel.bindList("/StickerMaster", null, null, aFilters, {
            });

            return oBinding.getHeaderContext().requestProperty("$count");
        },

        _checkActiveStickerLimit: function () {
            return this._requestActiveStickerCount().then(function (iCount) {
                if (iCount < MAX_ACTIVE_STICKERS) {
                    return;
                }

                MessageBox.error(
                    "You already have " + iCount + " active stickers. A maximum of " +
                    MAX_ACTIVE_STICKERS + " is allowed, so a new request can only be " +
                    "created once one of them expires."
                );

                return Promise.reject(new Error("Active sticker limit reached."));
            }, function (err) {
                console.error("Failed to read the active sticker count:", err);
            });
        },

        _applyActionGuards: function () {
            this._guardActionButton("reschedulePopup", {
                properties: APPOINTMENT_PROPERTIES,
                validate: this._validateAppointmentChange
            });
            this._guardActionButton("RenewSticker", {
                properties: RENEW_PROPERTIES,
                validate: this._validateRenew
            });
            this._guardActionButton("CancelRequest", {
                properties: APPOINTMENT_PROPERTIES,
                validate: this._validateAppointmentChange,
                confirm: this._confirmCancel
            });
        },

        _guardActionButton: function (sActionName, mGuard) {
            var that = this;
            var oView = this.base.getView();

            var aButtons = oView.findAggregatedObjects(true, function (oControl) {
                return oControl.isA("sap.m.Button") &&
                    oControl.getId().indexOf(sActionName) !== -1;
            });

            aButtons.forEach(function (oButton) {
                if (oButton.data(GUARD_FLAG)) { return; }

                var aHandlers = ((oButton.mEventRegistry && oButton.mEventRegistry.press) || []).slice();
                if (!aHandlers.length) { return; }

                aHandlers.forEach(function (oHandler) {
                    oButton.detachPress(oHandler.fFunction, oHandler.oListener);
                });

                oButton.attachPress(function (oEvent) {
                    var aContexts = that._resolveActionContexts(oButton);

                    var oReplayEvent = new Event(
                        oEvent.getId(), oEvent.getSource(), Object.assign({}, oEvent.getParameters())
                    );
                    var fnReplay = function () {
                        aHandlers.forEach(function (oHandler) {
                            oHandler.fFunction.call(oHandler.oListener || oButton, oReplayEvent, oHandler.oData);
                        });
                    };

                    that._requestGuardProperties(aContexts, mGuard.properties).then(function () {
                        var sError = null;
                        aContexts.some(function (oContext) {
                            sError = mGuard.validate.call(that, oContext);
                            return !!sError;
                        });

                        if (sError) {
                            MessageBox.error(sError);
                            return;
                        }

                        var sConfirm = mGuard.confirm ? mGuard.confirm.call(that, aContexts) : null;

                        if (!sConfirm) {
                            fnReplay();

                            if (sActionName === "RenewSticker") {
                                var iAttempts = 0;
                                var iInterval = setInterval(function () {
                                    var aDialogs = oView.findAggregatedObjects(true, function (oControl) {
                                        return oControl.isA("sap.m.Dialog") && oControl.getId().indexOf("RenewSticker") !== -1;
                                    });

                                    if (aDialogs.length > 0) {
                                        clearInterval(iInterval);
                                        var oDialog = aDialogs[0];

                                        // Make dialog thinner to perfectly wrap the input fields
                                        oDialog.setContentWidth("300px");

                                        sap.ui.require(["sap/m/MessageStrip"], function (MessageStrip) {
                                            var aContent = oDialog.getContent() || [];
                                            var bHasMsg = aContent.some(function (c) { return c.isA("sap.m.MessageStrip"); });

                                            if (!bHasMsg) {
                                                var oMsg = new MessageStrip({
                                                    text: "Please review the request and validate the supporting attachments.",
                                                    type: "Information",
                                                    showIcon: true
                                                });

                                                // Margin so it doesn't touch the fields or buttons directly
                                                oMsg.addStyleClass("sapUiSmallMarginTop");

                                                // Append to bottom (right above the buttons)
                                                oDialog.addContent(oMsg);
                                            }
                                        });
                                    }

                                    iAttempts++;
                                    if (iAttempts > 40) { clearInterval(iInterval); }
                                }, 50);
                            }

                            return;
                        }

                        MessageBox.confirm(sConfirm, {
                            actions: [MessageBox.Action.YES, MessageBox.Action.NO],
                            emphasizedAction: MessageBox.Action.YES,
                            onClose: function (sAction) {
                                if (sAction === MessageBox.Action.YES) {
                                    fnReplay();
                                }
                            }
                        });
                    });
                });

                oButton.data(GUARD_FLAG, true);
            });
        },

        _resolveActionContexts: function (oButton) {
            var oContext = oButton.getBindingContext();
            if (oContext) { return [oContext]; }

            var oParent = oButton.getParent();
            while (oParent) {
                if (oParent.isA("sap.ui.mdc.Table")) {
                    return oParent.getSelectedContexts() || [];
                }
                oParent = oParent.getParent();
            }

            oContext = this.base.getView().getBindingContext();
            return oContext ? [oContext] : [];
        },

        _requestGuardProperties: function (aContexts, aProperties) {
            var aRequests = [];

            aContexts.forEach(function (oContext) {
                aProperties.forEach(function (sProperty) {
                    aRequests.push(
                        oContext.requestProperty(sProperty).catch(function (err) {
                            console.error("Failed to read " + sProperty + " for the action guard:", err);
                        })
                    );
                });
            });

            return Promise.all(aRequests);
        },

        _validateAppointmentChange: function (oContext) {
            if (this._bIsStickerAdmin) { return null; }

            var oAppointment = toLocalDate(
                oContext.getProperty("AppointmentDate"),
                oContext.getProperty("AppointmentFromTime")
            );
            if (!oAppointment) { return null; }

            var iHoursLeft = (oAppointment.getTime() - Date.now()) / MS_PER_HOUR;
            if (iHoursLeft < APPOINTMENT_CUTOFF_HOURS) {
                return "Please note that appointments can only be rescheduled or canceled up to " +
                    APPOINTMENT_CUTOFF_HOURS +
                    " hours before the approved appointment date and time.";
            }
            return null;
        },

        _confirmCancel: function (aContexts) {
            if (aContexts.length > 1) {
                return "Are you sure you want to cancel the " + aContexts.length +
                    " selected requests? This cannot be undone.";
            }
            return "Are you sure you want to cancel this request? This cannot be undone.";
        },

        _validateRenew: function (oContext) {
            var oExpire = toLocalDate(oContext.getProperty("ExpireDate"));
            if (!oExpire) {
                return "This request cannot be renewed because it has no expiry date.";
            }

            var oToday = startOfToday();
            var iDaysLeft = Math.round((oExpire.getTime() - oToday.getTime()) / MS_PER_DAY);

            if (iDaysLeft < 0) {
                return "This sticker expired on " + formatDate(oExpire) +
                    " and can no longer be renewed.";
            }
            if (iDaysLeft > RENEW_WINDOW_DAYS) {
                return "This sticker expires on " + formatDate(oExpire) +
                    ". Renewal is only possible within " + RENEW_WINDOW_DAYS +
                    " days before the expiry date, from " +
                    formatDate(addDays(oExpire, -RENEW_WINDOW_DAYS)) + ".";
            }
            return null;
        },

        _applyMaintenanceActionVisibility: function () {
            document.body.classList.add("hideMaintenanceActions");
            document.body.classList.add("hideAdminOnlyActions");

            var that = this;
            this._bIsStickerAdmin = false;

            var oView = this.base.getView();
            var oComponent = this.base.getAppComponent?.();

            var oVarModel =
                (oComponent && oComponent.getModel("varAuth")) ||
                (oView && oView.getModel("varAuth"));

            if (!oVarModel) {
                console.error("varAuth model not available.");
                return;
            }

            try {
                var oBinding = oVarModel.bindList(
                    "/EmployeeHeader",
                    null,
                    null,
                    null,
                    { $$groupId: "$direct" }
                );

                oBinding.requestContexts(0, 1).then(function (aContexts) {

                    var bIsStickerAdmin = false;

                    if (aContexts.length) {
                        bIsStickerAdmin =
                            aContexts[0].getObject()?.StickerAdmin === "X";
                    }

                    that._bIsStickerAdmin = bIsStickerAdmin;

                    if (bIsStickerAdmin) {
                        document.body.classList.add("hideMaintenanceActions");
                        document.body.classList.remove("hideAdminOnlyActions");
                    } else {
                        document.body.classList.remove("hideMaintenanceActions");
                        document.body.classList.add("hideAdminOnlyActions");
                    }

                }).catch(function (err) {
                    console.error(err);
                });

            } catch (err) {
                console.error(err);
            }
        }
    });
});
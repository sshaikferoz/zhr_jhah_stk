sap.ui.define([
    "sap/ui/core/mvc/ControllerExtension",
    "sap/ui/core/Fragment",
    "sap/ui/core/Element",
    "sap/ui/core/format/DateFormat",
    "sap/ui/base/Event",
    "sap/ui/model/Filter",
    "sap/ui/model/FilterOperator",
    "sap/ui/model/json/JSONModel",
    "sap/m/MessageBox",
    "sap/m/Label",
    "sap/m/Text",
    "sap/ui/layout/form/FormElement",
    "com/jhah/zhrjhahsecstk/ext/util/SlotTimeFormat"
], function (ControllerExtension, Fragment, Element, DateFormat, Event, Filter, FilterOperator, JSONModel, MessageBox, Label, Text, FormElement, SlotTimeFormat) {
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
    var RESCHEDULE_PROPERTIES = APPOINTMENT_PROPERTIES.concat(["isSecurityRescheduled"]);
    var RENEW_PROPERTIES = ["ExpireDate"];
    var ISSUE_PROPERTIES = ["ContractEnddate", "StkType"];

    var HIDE_VALIDITY_STK_TYPE = "RMV";
    var CONTRACT_END_FIELD_FLAG = "zhrContractEndField";
    var PLATENUM_READONLY_FLAG = "zhrPlateNumReadOnly";

    var oDateFormat = DateFormat.getDateInstance({ style: "medium" });
    var oEdmDateFormat = DateFormat.getDateInstance({ pattern: "yyyy-MM-dd", calendarType: "Gregorian" });

    // ========================================================================
    // CONSOLIDATED VALIDATION & ERROR MESSAGES
    // ========================================================================
    var VALIDATION_MESSAGES = {
        invalidAppointmentDate: "Please select an available appointment date.",
        activeStickerLimit: function (iCount, iMax) {
            return "You already have " + iCount + " active stickers. A maximum of " + iMax + " is allowed, so a new request can only be created once one of them expires.";
        },
        appointmentCutoff: function (iHours) {
            return "Please note that appointments can only be rescheduled or canceled up to " + iHours + " hours before the approved appointment date and time.";
        },
        confirmCancelMultiple: function (iCount) {
            return "Are you sure you want to cancel the " + iCount + " selected requests? This cannot be undone.";
        },
        confirmCancelSingle: "Are you sure you want to cancel this request? This cannot be undone.",
        renewNoExpiry: "This request cannot be renewed because it has no expiry date.",
        renewAlreadyExpired: function (sDate) {
            return "This sticker expired on " + sDate + " and can no longer be renewed.";
        },
        renewNotYetEligible: function (sExpireDate, iDays, sEligibleDate) {
            return "This sticker expires on " + sExpireDate + ". Renewal is only possible within " + iDays + " days before the expiry date, from " + sEligibleDate + ".";
        },
        noLineItem: "No Line Item selected.",
        noStickerForRenew: "There is no active sticker to renew.",
        noStickerForCancel: "There is no active sticker to cancel."
    };

    function formatDate(oDate) {
        return oDate ? oDateFormat.format(oDate) : "";
    }

    function toLocalDate(sDate, sTime) {
        if (!sDate) { return null; }
        var oDate = new Date(sDate + "T" + (sTime || "00:00:00"));
        return isNaN(oDate.getTime()) ? null : oDate;
    }

    function isTrueFlag(vValue) {
        return vValue === true || vValue === "X" || vValue === "x";
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

                    // 1. Applies List Report & Global Role via original CSS method
                    this._applyMaintenanceActionVisibility();

                    this._markAppointmentFieldsMandatory();
                    this._markAttachmentsMandatory();
                    this._applyUIEnhancements();
                    this._hideEditingStatusFilter();

                    var oFioriI18nModel = oView && oView.getModel("sap.fe.i18n");
                    if (oFioriI18nModel && !oFioriI18nModel.__jhahCustomTextsApplied) {
                        oFioriI18nModel.enhance({ bundleName: "com.jhah.zhrjhahsecstk.i18n.i18n" });
                        oFioriI18nModel.__jhahCustomTextsApplied = true;
                        this._log("Fiori Elements texts enhanced.", { bundleName: "com.jhah.zhrjhahsecstk.i18n.i18n" });
                    }

                } catch (err) {
                    console.error("Error in StickerControllerExtension onInit:", err);
                }
            },

            routing: {
                onAfterBinding: function (oBindingContext) {
                    var oView = this.base.getView();
                    var oAppModel = oView.getModel();

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

                    // Only act on the Sticker Master object page context
                    if (oBindingContext && oBindingContext.getPath().indexOf("/StickerMaster") !== -1) {

                        // 2. Safely process Object Page specific button hiding
                        this._applyRequestVisibility(oBindingContext);

                        this._loadAppointmentSlots(oView, oAppModel, oBindingContext);

                        oBindingContext.requestProperty("JhahId").then(function (sJhahId) {
                            if (sJhahId && sJhahId.trim() !== "") {
                                var sPath = "/EmployeeDetails('" + sJhahId + "')";
                                var oContext = oAppModel.bindContext(sPath, null, { "$$groupId": "$direct" });

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

        _log: function (sMessage, oData) {
            var sLog = "[JHAH-EXT] " + sMessage;
            if (oData !== undefined) console.log(sLog, oData);
            else console.log(sLog);
        },

        // ========================================================================
        // 1. ORIGINAL LIST REPORT & ROLE LOGIC (Untouched, CSS Based)
        // ========================================================================
        // _applyMaintenanceActionVisibility: function () {
        //     // Safe default: hide everything until authorization is known
        //     document.body.classList.add("hideMaintenanceActions");
        //     document.body.classList.add("hideAdminOnlyActions");

        //     var that = this;
        //     this._bIsStickerAdmin = false;

        //     var oView = this.base.getView();
        //     var oComponent = this.base.getAppComponent && this.base.getAppComponent();
        //     var oVarModel = (oComponent && oComponent.getModel("varAuth")) || (oView && oView.getModel("varAuth"));

        //     if (!oVarModel) return;

        //     try {
        //         var oBinding = oVarModel.bindList("/EmployeeHeader", null, null, null, { $$groupId: "$direct" });
        //         oBinding.requestContexts(0, 1).then(function (aContexts) {
        //             var bIsStickerAdmin = false;
        //             if (aContexts.length) {
        //                 bIsStickerAdmin = aContexts[0].getObject() && aContexts[0].getObject().StickerAdmin === "X";
        //             }

        //             that._bIsStickerAdmin = bIsStickerAdmin;

        //             if (bIsStickerAdmin) {
        //                 document.body.classList.add("hideMaintenanceActions");
        //                 document.body.classList.remove("hideAdminOnlyActions");
        //             } else {
        //                 document.body.classList.remove("hideMaintenanceActions");
        //                 document.body.classList.add("hideAdminOnlyActions");
        //             }
        //         }).catch(function (err) {
        //             console.error("Failed to determine StickerAdmin role", err);
        //         });
        //     } catch (err) {
        //         console.error(err);
        //     }
        // },
        _applyMaintenanceActionVisibility: function () {
            // Safe default: hide everything until authorization is known
            document.body.classList.add("hideMaintenanceActions");
            document.body.classList.add("hideAdminOnlyActions");

            var that = this;
            this._bIsStickerAdmin = false;

            var oView = this.base.getView();
            var oComponent = this.base.getAppComponent && this.base.getAppComponent();
            var oVarModel = (oComponent && oComponent.getModel("varAuth")) || (oView && oView.getModel("varAuth"));

            if (!oVarModel) return;

            try {
                var oBinding = oVarModel.bindList("/EmployeeHeader", null, null, null, { $$groupId: "$direct" });
                oBinding.requestContexts(0, 1).then(function (aContexts) {
                    var bIsStickerAdmin = false;
                    if (aContexts.length) {
                        bIsStickerAdmin = aContexts[0].getObject() && aContexts[0].getObject().StickerAdmin === "X";
                    }

                    that._bIsStickerAdmin = bIsStickerAdmin;

                    if (bIsStickerAdmin) {
                        document.body.classList.add("hideMaintenanceActions");
                        document.body.classList.remove("hideAdminOnlyActions");
                    } else {
                        document.body.classList.remove("hideMaintenanceActions");
                        document.body.classList.add("hideAdminOnlyActions");
                    }

                    var oTabBar = oView.byId("fe::TabMultipleMode");

                    if (oTabBar && typeof oTabBar.getItems === "function") {
                        var aTabs = oTabBar.getItems();

                        aTabs.forEach(function (oTab) {
                            var sText = "";
                            if (typeof oTab.getText === "function") {
                                sText = oTab.getText() || "";
                            }

                            // If this is the Employee Requests tab, set visibility based on Admin role
                            if (sText.indexOf("Employee Requests") !== -1) {
                                oTab.setVisible(bIsStickerAdmin);
                            }
                        });
                    }
                }).catch(function (err) {
                    console.error("Failed to determine StickerAdmin role", err);
                });
            } catch (err) {
                console.error(err);
            }
        },
        // ========================================================================
        // 2. ISOLATED OBJECT PAGE LOGIC (No CSS, UI5 Specific)
        // ========================================================================
        // _applyRequestVisibility: async function (oContext) {
        //     if (!oContext) return;
        //     var oView = this.base.getView();
        //     var that = this;

        //     // --- WEBIDE TESTING BYPASS --- 
        //     // Change these to test without backend calls
        //     var sBypassRole = ""; // Options: "ADMIN", "EMPLOYEE", ""
        //     var sBypassOwnership = ""; // Options: "MINE", "OTHER", ""
        //     // -----------------------------

        //     try {
        //         // Determine Admin Role
        //         var bIsAdmin = false;
        //         if (sBypassRole === "ADMIN") bIsAdmin = true;
        //         else if (sBypassRole === "EMPLOYEE") bIsAdmin = false;
        //         else {
        //             var oVarModel = oView.getModel("varAuth") || (this.base.getAppComponent && this.base.getAppComponent().getModel("varAuth"));
        //             if (oVarModel) {
        //                 var aRoles = await oVarModel.bindList("/EmployeeHeader", null, null, null, { $$groupId: "$direct" }).requestContexts(0, 1);
        //                 if (aRoles.length) bIsAdmin = (aRoles[0].getObject().StickerAdmin === "X");
        //             }
        //         }
        //         that._bIsStickerAdmin = bIsAdmin; // Sync with global variable

        //         // Determine Request Ownership
        //         var bIsMyRequestBool = false;
        //         if (sBypassOwnership === "MINE") bIsMyRequestBool = true;
        //         else if (sBypassOwnership === "OTHER") bIsMyRequestBool = false;
        //         else {
        //             var bIsMyRequest = await oContext.requestProperty("IsMyRequest");
        //             bIsMyRequestBool = (bIsMyRequest === true || bIsMyRequest === "X" || bIsMyRequest === "true");
        //         }

        //         var bHideAdminButtons = false;
        //         var bHideEmployeeButtons = false;

        //         if (!bIsAdmin) {
        //             bHideAdminButtons = true; // Employee viewing request
        //         } else {
        //             if (bIsMyRequestBool) {
        //                 bHideAdminButtons = true; // Admin viewing OWN request
        //             } else {
        //                 bHideEmployeeButtons = true; // Admin viewing OTHER request
        //             }
        //         }

        //         var fnEnforceObjectPageButtons = function() {
        //             // CRITICAL: We find the ObjectPageLayout specifically. 
        //             // This physically prevents us from hiding buttons on the List Report.
        //             var aObjectPages = oView.findAggregatedObjects(true, function(o) { 
        //                 return o.isA("sap.uxap.ObjectPageLayout"); 
        //             });

        //             if (aObjectPages.length === 0) return; // Not on Object Page

        //             var oObjectPage = aObjectPages[0];
        //             var aButtons = oObjectPage.findAggregatedObjects(true, function(o) { return o.isA("sap.m.Button"); });

        //             aButtons.forEach(function(oBtn) {
        //                 var sId = String(oBtn.getId() || "").toUpperCase();

        //                 var bIsAdminAction = sId.indexOf("MAINTAPPOINTMENTLOCATION") !== -1 || sId.indexOf("ISSUESTICKER") !== -1 || sId.indexOf("NOSHOW") !== -1 || sId.indexOf("APPROVE") !== -1 || sId.indexOf("REJECT") !== -1;
        //                 var bIsEmpAction = sId.indexOf("STANDARDACTION::DELETE") !== -1 || sId.indexOf("COPYSTICKER") !== -1 || sId.indexOf("STANDARDACTION::EDIT") !== -1 || sId.indexOf("CANCELREQUEST") !== -1 || sId.indexOf("CREATESELFSTKREQ") !== -1 || (sId.indexOf("RENEW") !== -1 && sId.indexOf("RENEWON") === -1) || sId.indexOf("REMOVE") !== -1;

        //                 if (bIsAdminAction && bHideAdminButtons && typeof oBtn.setVisible === "function") {
        //                     oBtn.setVisible(false);
        //                 }
        //                 if (bIsEmpAction && bHideEmployeeButtons && typeof oBtn.setVisible === "function") {
        //                     oBtn.setVisible(false);
        //                 }
        //             });
        //         };

        //         // Apply immediately, and retry briefly to catch lazy-rendered buttons
        //         fnEnforceObjectPageButtons();
        //         setTimeout(fnEnforceObjectPageButtons, 300);
        //         setTimeout(fnEnforceObjectPageButtons, 800);

        //     } catch (e) {
        //         console.error("Error evaluating Request Ownership for Object Page:", e);
        //     }
        // },

        // ========================================================================
        // 2. ISOLATED OBJECT PAGE LOGIC (CSS Class Based)
        // ========================================================================
        _applyRequestVisibility: async function (oContext) {
            if (!oContext) return;
            var oView = this.base.getView();
            var that = this;

            oView.addStyleClass("loadingOwnershipMode");
            oView.removeStyleClass("myRequestMode");
            oView.removeStyleClass("otherRequestMode");

            try {
                var bIsAdmin = false;
                var oVarModel = oView.getModel("varAuth") || (this.base.getAppComponent && this.base.getAppComponent().getModel("varAuth"));
                if (oVarModel) {
                    var aRoles = await oVarModel.bindList("/EmployeeHeader", null, null, null, { $$groupId: "$direct" }).requestContexts(0, 1);
                    if (aRoles.length) bIsAdmin = (aRoles[0].getObject().StickerAdmin === "X");
                }
                that._bIsStickerAdmin = bIsAdmin;

                var bIsMyRequest = await oContext.requestProperty("IsMyRequest");
                var bIsMyRequestBool = (bIsMyRequest === true || bIsMyRequest === "X" || bIsMyRequest === "true");

                oView.removeStyleClass("loadingOwnershipMode");

                if (!bIsAdmin) {
                    // Regular Employee viewing request -> Hide Admin buttons
                    oView.addStyleClass("myRequestMode");
                } else {
                    if (bIsMyRequestBool) {
                        oView.addStyleClass("myRequestMode");
                    } else {
                        oView.addStyleClass("otherRequestMode");
                    }
                }

            } catch (e) {
                console.error("Error evaluating Request Ownership for Object Page:", e);
                oView.removeStyleClass("loadingOwnershipMode");
            }
        },

        _hideEditingStatusFilter: function () {
            var oExtension = this;

            if (this._pEditingStatusReset) {
                clearInterval(this._pEditingStatusReset);
            }

            var iAttempts = 0;
            var iMaxAttempts = 100;

            this._pEditingStatusReset = setInterval(function () {
                iAttempts++;
                var bDone = false;

                try {
                    var aBars = sap.ui.core.Element.registry.filter(function (oControl) {
                        return (oControl && oControl.isA && (oControl.isA("sap.ui.mdc.FilterBar") || oControl.isA("sap.ui.comp.smartfilterbar.SmartFilterBar")));
                    });

                    for (var i = 0; i < aBars.length; i++) {
                        var oFilterBar = aBars[i];

                        if (oFilterBar._oP13nFilter && typeof oFilterBar._oP13nFilter.getP13nData === "function") {
                            var oP13nData = oFilterBar._oP13nFilter.getP13nData();

                            if (oP13nData && Array.isArray(oP13nData.items)) {
                                var oEditState = oP13nData.items.find(function (oItem) {
                                    return (oItem.key === "$editState" || oItem.name === "$editState");
                                });

                                if (oEditState) {
                                    oEditState.visible = false;
                                    try {
                                        if (typeof oFilterBar.setFilterConditions === "function") {
                                            var mConditions = oFilterBar.getFilterConditions() || {};
                                            if (mConditions["$editState"]) {
                                                delete mConditions["$editState"];
                                                oFilterBar.setFilterConditions(mConditions);
                                            }
                                        }

                                        oFilterBar._oP13nFilter.setP13nData(oP13nData);
                                        bDone = true;
                                    } catch (e) { }
                                }
                            }
                        }

                        if (typeof oFilterBar.getFilterItems === "function") {
                            var aItems = oFilterBar.getFilterItems() || [];
                            aItems.forEach(function (oItem) {
                                var sId = String(oItem.getId() || "");
                                if (sId.indexOf("editState") !== -1 || sId.indexOf("EditingStatus") !== -1 || sId.indexOf("DraftEditingStatus") !== -1) {
                                    try {
                                        oItem.setVisible(false);
                                        bDone = true;
                                    } catch (e) { }
                                }
                            });
                        }
                    }
                } catch (oError) { }

                if (bDone || iAttempts >= iMaxAttempts) {
                    clearInterval(oExtension._pEditingStatusReset);
                    oExtension._pEditingStatusReset = null;
                }
            }, 200);
        },

        _applyUIEnhancements: function () {
            var oExtension = this;
            var oView = this.base.getView();
            var $view = oView.$();

            if (!$view || $view.length === 0) {
                setTimeout(function () {
                    oExtension._applyUIEnhancements();
                }, 200);
                return;
            }

            var domView = $view[0];

            var EVIDENCE_CREATE_BUTTON_ID =
                "com.jhah.zhrjhahsecstk::StickerMasterObjectPage--" +
                "fe::table::_Evidence::LineItem::StandardAction::Create";
            var EVIDENCE_TARGET_TEXT = "Add Attachment";
            var FOOTER_TARGET_TEXT = "Submit";
            var FOOTER_SELECTOR =
                ".sapMFooter-CTX, .sapFDynamicPageFooter, .sapMPageFooter, footer";

            function relabelIfCreate(oButton, sTargetText) {
                if (!oButton || typeof oButton.getText !== "function") { return; }
                if (oButton.getText() === sTargetText) { return; }
                if (String(oButton.getText() || "").trim().toUpperCase() !== "CREATE") { return; }
                oButton.setText(sTargetText);
            }

            var fnChangeCreateToSubmit = function () {
                try {
                    if (!domView.isConnected) { return; }

                    relabelIfCreate(
                        sap.ui.getCore().byId(EVIDENCE_CREATE_BUTTON_ID),
                        EVIDENCE_TARGET_TEXT
                    );

                    var aBtnEls = domView.querySelectorAll(".sapMBtn");
                    for (var i = 0; i < aBtnEls.length; i++) {
                        var oBtn = sap.ui.core.Element.closestTo(aBtnEls[i]);
                        if (!oBtn || typeof oBtn.getText !== "function") { continue; }
                        if (String(oBtn.getText() || "").trim().toUpperCase() !== "CREATE") { continue; }
                        if (!aBtnEls[i].closest(FOOTER_SELECTOR)) { continue; }
                        relabelIfCreate(oBtn, FOOTER_TARGET_TEXT);
                    }
                } catch (e) { }
            };

            fnChangeCreateToSubmit();
            setTimeout(fnChangeCreateToSubmit, 300);
            setTimeout(fnChangeCreateToSubmit, 1000);

            if (!$view.data("createToSubmitObserverAttached")) {
                var iDebounceHandle = null;

                var oObserver = new MutationObserver(function () {
                    if (iDebounceHandle) { clearTimeout(iDebounceHandle); }
                    iDebounceHandle = setTimeout(fnChangeCreateToSubmit, 50);
                });

                oObserver.observe(domView, { childList: true, subtree: true });
                $view.data("createToSubmitObserverAttached", true);
                $view.data("createToSubmitObserver", oObserver);
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
                "fe::FormContainer::AppointSpecFacet::FormElement::DataField::AppointmentLocation-label",
                "fe::FormContainer::RequestGrpFacet::FormElement::DataField::Location-label",
                "fe::FormContainer::RequestGrpFacet::FormElement::DataField::StkType-label"
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
                oDatePicker.setValueStateText(VALIDATION_MESSAGES.invalidAppointmentDate);
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

            var oBinding = oModel.bindList("/StickerMaster", null, null, aFilters, {});
            return oBinding.getHeaderContext().requestProperty("$count");
        },

        _checkActiveStickerLimit: function () {
            return this._requestActiveStickerCount().then(function (iCount) {
                if (iCount < MAX_ACTIVE_STICKERS) {
                    return;
                }

                MessageBox.error(VALIDATION_MESSAGES.activeStickerLimit(iCount, MAX_ACTIVE_STICKERS));
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
            this._guardActionButton("Remove", {
                properties: [],
                validate: this._validateCancelStickerNumber,
                afterReplay: this.__disablePlateNumField
            });
            this._guardActionButton("Renew", {
                properties: [],
                validate: this._validateRenewStickerNumber,
                afterReplay: this.__disablePlateNumField
            });

            // [JHAH FIX LOG: MASSIVELY UPGRADED ISSUE STICKER GUARD]
            this._guardActionButton("IssueSticker", {
                properties: ISSUE_PROPERTIES,
                validate: function () { return null; },
                afterReplay: function (aContexts) {
                    var that = this;

                    // Safely extract Context without crashing
                    var oCtx = Array.isArray(aContexts) ? aContexts[0] : aContexts;
                    var sStkType = "";
                    if (oCtx && typeof oCtx.getProperty === "function") {
                        sStkType = oCtx.getProperty("StkType");
                    }

                    console.log("[JHAH FIX LOG] IssueSticker clicked. Detected StkType:", sStkType);

                    // If it's RMV, CAN, or CANCEL, we treat it as a Cancel Request
                    var bIsCancelRequest = (sStkType === HIDE_VALIDITY_STK_TYPE || sStkType === "CAN" || sStkType === "CANCEL");

                    console.log("[JHAH FIX LOG] Is this a Cancel Request?", bIsCancelRequest);

                    // We now pass a boolean (true = hide, false = show)
                    that._applyIssueValidityPeriodVisibility(bIsCancelRequest);

                    // Inject Contract End Date, but tell it whether to SHOW or HIDE based on bIsCancelRequest
                    that._injectIssueContractEndDate(oCtx, !bIsCancelRequest, function () {
                        console.log("[JHAH FIX LOG] Completed UI modifications for Process Sticker Request.");
                    });
                }
            });

            // [JHAH FIX LOG: ENSURE VALIDITY PERIOD HIDES ON CANCEL REQUEST (CACHE FIX)]
            this._guardActionButton("CancelRequest", {
                properties: APPOINTMENT_PROPERTIES,
                validate: this._validateAppointmentChange,
                confirm: this._confirmCancel,
                afterReplay: function () {
                    var that = this;
                    console.log("[JHAH FIX LOG] CancelRequest clicked. Forcing Validity Period to hide.");
                    that._applyIssueValidityPeriodVisibility(true);
                }
            });
        },

        _guardActionButton: function (sActionName, mGuard) {
            var that = this;
            var oView = this.base.getView();

            var aButtons = oView.findAggregatedObjects(true, function (oControl) {
                return oControl.isA("sap.m.Button") && oControl.getId().indexOf(sActionName) !== -1;
            });

            aButtons.forEach(function (oButton) {
                if (oButton.data(GUARD_FLAG)) { return; }

                var aHandlers = ((oButton.mEventRegistry && oButton.mEventRegistry.press) || []).slice();
                if (!aHandlers.length) { return; }

                aHandlers.forEach(function (oHandler) {
                    oButton.detachPress(oHandler.fFunction, oHandler.oListener);
                });

                // oButton.attachPress(function (oEvent) {
                //     var aContexts = that._resolveActionContexts(oButton, oEvent) || [];
                //     var oReplayEvent = new Event(oEvent.getId(), oEvent.getSource(), Object.assign({}, oEvent.getParameters()));

                //     var fnReplay = function () {
                //         aHandlers.forEach(function (oHandler) {
                //             oHandler.fFunction.call(oHandler.oListener || oButton, oReplayEvent, oHandler.oData);
                //         });
                //         if (mGuard.afterReplay) {
                //             mGuard.afterReplay.call(that, aContexts);
                //         }
                //     };

                //     that._requestGuardProperties(aContexts, mGuard.properties).then(function () {
                //         var sError = null;
                //         if (aContexts.length === 0) {
                //             sError = mGuard.validate.call(that, []);
                //         } else {
                //             sError = mGuard.validate.call(that, aContexts);
                //         }

                //         if (sError) {
                //             MessageBox.error(sError);
                //             return;
                //         }

                //         fnReplay();
                //     });
                // });

                oButton.attachPress(function (oEvent) {
                    var aContexts = that._resolveActionContexts(oButton, oEvent) || [];
                    var oReplayEvent = new Event(oEvent.getId(), oEvent.getSource(), Object.assign({}, oEvent.getParameters()));

                    var fnReplay = function () {
                        aHandlers.forEach(function (oHandler) {
                            oHandler.fFunction.call(
                                oHandler.oListener || oButton,
                                oReplayEvent,
                                oHandler.oData
                            );
                        });
                        if (mGuard.afterReplay) {
                            mGuard.afterReplay.call(
                                that,
                                aContexts
                            );
                        }
                    };

                    that._requestGuardProperties(aContexts, mGuard.properties).then(function () {

                        var vValidationResult;

                        if (aContexts.length === 0) {
                            vValidationResult =
                                mGuard.validate.call(that, []);
                        } else {
                            vValidationResult =
                                mGuard.validate.call(that, aContexts);
                        }

                        return Promise.resolve(vValidationResult).then(function (sError) {

                            if (sError) {
                                MessageBox.error(sError);
                                return;
                            }

                            fnReplay();
                        });
                    });
                });

                oButton.data(GUARD_FLAG, true);
            });
        },
        _resolveActionContexts: function (oButton, oEvent) {
            var oButtonContext = oButton.getBindingContext();
            if (oButtonContext) { return [oButtonContext]; }

            var oSource = oEvent && oEvent.getSource();
            if (oSource) {
                var oSourceContext = oSource.getBindingContext();
                if (oSourceContext) { return [oSourceContext]; }
            }

            var oCurrent = oButton;
            while (oCurrent) {
                var oParentContext = oCurrent.getBindingContext && oCurrent.getBindingContext();
                if (oParentContext) { return [oParentContext]; }

                if (oCurrent.isA && oCurrent.isA("sap.ui.mdc.Table")) {
                    if (typeof oCurrent.getSelectedContexts === "function") {
                        var aSelectedContexts = oCurrent.getSelectedContexts() || [];
                        if (aSelectedContexts.length > 0) { return aSelectedContexts; }
                    }

                    var oInnerTable = oCurrent.getAggregation && oCurrent.getAggregation("_content");
                    if (oInnerTable && typeof oInnerTable.getItems === "function") {
                        var aRows = oInnerTable.getItems() || [];
                        var aRowContexts = aRows.map(function (oRow) {
                            return oRow.getBindingContext();
                        }).filter(Boolean);

                        if (aRowContexts.length > 0) { return aRowContexts; }
                    }
                    break;
                }
                oCurrent = oCurrent.getParent();
            }
            return [];
        },

        _requestGuardProperties: function (aContexts, aProperties) {
            var aRequests = [];
            aContexts.forEach(function (oContext) {
                aProperties.forEach(function (sProperty) {
                    aRequests.push(oContext.requestProperty(sProperty).catch(function (err) { }));
                });
            });
            return Promise.all(aRequests);
        },

        _validateRenewStickerNumber: function () {

            return this._checkRenewStickerCount().then(function (iCount) {

                console.log(
                    "[JHAH-EXT] Count returned to validation:",
                    iCount
                );

                if (Number(iCount) === 0){
                    return "There is no active sticker to renew.";
                }

                return null;
            });
        },
        _validateCancelStickerNumber: function (aContexts) {
            return this._checkRemoveStickerCount().then(function (iCount) {

                console.log(
                    "[JHAH-EXT] Count returned to validation:",
                    iCount
                );

                if (Number(iCount) === 0) {
                    return "There is no active sticker to remove.";
                }
            });
        },

        _checkRenewStickerCount: function () {
            var sUrl =
                "/sap/opu/odata4/sap/zui_hr_stk/srvd_f4/sap/zi_hr_stk_renew_vh/0001" +
                ";ps='srvd-zsrv_hr_stk-0001'" +
                ";va='com.sap.gateway.srvd.zsrv_hr_stk.v0001.ae-zc_hr_stk_mstr.renew.stickernumber.StickerMasterType.X'" +
                "/ZI_HR_STK_RENEW_VH" +
                "?$select=Pernr,PlateNum,StickerNumber,StkReqId" +
                "&$orderby=StickerNumber" +
                "&$count=true" +
                "&$skip=0" +
                "&$top=100";

            return new Promise(function (resolve, reject) {

                jQuery.ajax({
                    url: sUrl,
                    method: "GET",
                    dataType: "json",
                    headers: {
                        "Accept": "application/json"
                    },

                    success: function (oData) {

                        var iCount = Number(oData["@odata.count"] || 0);

                        console.log(
                            "[JHAH-EXT] Renew Sticker Count:",
                            iCount
                        );

                        resolve(iCount);
                    },

                    error: function (oError) {

                        console.error(
                            "[JHAH-EXT] Renew Sticker Count Error:",
                            oError
                        );

                        reject(oError);
                    }
                });
            });
        },
        _checkRemoveStickerCount: function () {
            var sUrl =
                "/sap/opu/odata4/sap/zui_hr_stk/srvd_f4/sap/zi_hr_stk_remove_vh/0001" +
                ";ps='srvd-zsrv_hr_stk-0001'" +
                ";va='com.sap.gateway.srvd.zsrv_hr_stk.v0001.ae-zc_hr_stk_mstr.remove.stickernumber.StickerMasterType.X'" +
                "/ZI_HR_STK_REMOVE_VH" +
                "?$select=Pernr,PlateNum,StickerNumber,StkReqId" +
                "&$orderby=StickerNumber" +
                "&$count=true" +
                "&$skip=0" +
                "&$top=100";

            return new Promise(function (resolve, reject) {

                jQuery.ajax({
                    url: sUrl,
                    method: "GET",
                    dataType: "json",
                    headers: {
                        "Accept": "application/json"
                    },

                    success: function (oData) {

                        var iCount = Number(oData["@odata.count"] || 0);

                        console.log(
                            "[JHAH-EXT] Remove Sticker Count:",
                            iCount
                        );

                        resolve(iCount);
                    },

                    error: function (oError) {

                        console.error(
                            "[JHAH-EXT] Remove Sticker Count Error:",
                            oError
                        );

                        reject(oError);
                    }
                });
            });
        },

        _validateReschedule: function (oContext) {
            if (isTrueFlag(oContext.getProperty("isSecurityRescheduled"))) {
                return null;
            }
            return this._validateAppointmentChange(oContext);
        },

        _validateAppointmentChange: function (oContext) {
            if (this._bIsStickerAdmin) { return null; }

            // [JHAH FIX LOG: SAFE CONTEXT EXTRACTION]
            var oCtx = Array.isArray(oContext) ? oContext[0] : oContext;
            if (!oCtx || typeof oCtx.getProperty !== "function") return null;

            var oAppointment = toLocalDate(
                oCtx.getProperty("AppointmentDate"),
                oCtx.getProperty("AppointmentFromTime")
            );
            if (!oAppointment) { return null; }

            var iHoursLeft = (oAppointment.getTime() - Date.now()) / MS_PER_HOUR;
            if (iHoursLeft < APPOINTMENT_CUTOFF_HOURS) {
                return VALIDATION_MESSAGES.appointmentCutoff(APPOINTMENT_CUTOFF_HOURS);
            }
            return null;
        },

        _confirmCancel: function (aContexts) {
            if (aContexts.length > 1) {
                return VALIDATION_MESSAGES.confirmCancelMultiple(aContexts.length);
            }
            return VALIDATION_MESSAGES.confirmCancelSingle;
        },

        _validateRenew: function (oContext) {
            // [JHAH FIX LOG: SAFE CONTEXT EXTRACTION]
            var oCtx = Array.isArray(oContext) ? oContext[0] : oContext;
            if (!oCtx || typeof oCtx.getProperty !== "function") return null;

            var oExpire = toLocalDate(oCtx.getProperty("ExpireDate"));
            if (!oExpire) {
                return VALIDATION_MESSAGES.renewNoExpiry;
            }

            var oToday = startOfToday();
            var iDaysLeft = Math.round((oExpire.getTime() - oToday.getTime()) / MS_PER_DAY);

            if (iDaysLeft < 0) {
                return VALIDATION_MESSAGES.renewAlreadyExpired(formatDate(oExpire));
            }
            if (iDaysLeft > RENEW_WINDOW_DAYS) {
                return VALIDATION_MESSAGES.renewNotYetEligible(formatDate(oExpire), RENEW_WINDOW_DAYS, formatDate(addDays(oExpire, -RENEW_WINDOW_DAYS)));
            }
            return null;
        },

        _getText: function (sKey, sFallback) {
            var oModel = this.base.getView().getModel("i18n");
            var oBundle = oModel && oModel.getResourceBundle && oModel.getResourceBundle();
            return (oBundle && oBundle.getText(sKey)) || sFallback;
        },

        // [JHAH FIX LOG: ADDED bShow PARAMETER AND SAFE CONTEXT EXTRACTION]
        _injectIssueContractEndDate: function (oCtx, bShow, fnDone) {
            var that = this;

            console.log("[JHAH FIX LOG] _injectIssueContractEndDate triggered. Should Show?:", bShow);

            var sRaw = "";
            if (oCtx && typeof oCtx.getProperty === "function") {
                sRaw = oCtx.getProperty("ContractEnddate");
            }

            // Default to N/A if missing/empty
            var sValue = (sRaw && String(sRaw).trim() !== "") ? formatDate(toLocalDate(sRaw)) : "N/A";

            console.log("[JHAH FIX LOG] Extracted ContractEnddate:", sRaw, "-> Formatted as:", sValue);

            var iTries = 0;
            var iMaxTries = 40;
            var poll = function () {
                var oField = that._findActionDialogField("validityperiod");
                if (oField) {
                    console.log("[JHAH FIX LOG] Found Dialog Anchor. Updating Contract End Date field.");
                    that._addContractEndDateField(oField, sValue, bShow);
                    if (fnDone) { fnDone(); }
                    return;
                }
                if (++iTries < iMaxTries) {
                    setTimeout(poll, 100);
                } else {
                    console.warn("[JHAH FIX LOG] Could NOT find Dialog Anchor after polling!");
                    if (fnDone) { fnDone(); }
                }
            };
            poll();
        },

        __disablePlateNumField: function (oContext) {
            var that = this;
            var iTries = 0;
            var iMaxTries = 40;
            var poll = function () {
                var oField = that._findActionDialogField("platenum");
                if (oField) {
                    that._setFieldReadOnly(oField);
                    return;
                }
                if (++iTries < iMaxTries) {
                    setTimeout(poll, 100);
                }
            };
            poll();
        },

        _setFieldReadOnly: function (oField) {
            if (oField.data(PLATENUM_READONLY_FLAG)) { return; }
            if (typeof oField.setEditMode === "function") {
                oField.setEditMode("Display");
            } else if (typeof oField.setEditable === "function") {
                oField.setEditable(false);
            } else if (typeof oField.setEnabled === "function") {
                oField.setEnabled(false);
            }
            oField.data(PLATENUM_READONLY_FLAG, true);
        },

        // [JHAH FIX LOG: MODIFIED TO ACCEPT A BOOLEAN DIRECTLY]
        _applyIssueValidityPeriodVisibility: function (bHide) {
            var that = this;
            console.log("[JHAH FIX LOG] _applyIssueValidityPeriodVisibility triggered. Hide Validity Period?:", bHide);

            var iTries = 0;
            var iMaxTries = 40;
            var poll = function () {
                var oField = that._findActionDialogField("validityperiod");
                if (oField) {
                    console.log("[JHAH FIX LOG] Found Validity Period field. Setting visibility to:", !bHide);
                    that._setFormElementVisible(oField, !bHide);
                    return;
                }
                if (++iTries < iMaxTries) {
                    setTimeout(poll, 100);
                } else {
                    console.warn("[JHAH FIX LOG] Could NOT find Validity Period field to hide/show after polling!");
                }
            };
            poll();
        },

        _setFormElementVisible: function (oAnchorField, bVisible) {
            var oFormElement = oAnchorField;
            while (oFormElement && !oFormElement.isA("sap.ui.layout.form.FormElement")) {
                oFormElement = oFormElement.getParent();
            }
            if (!oFormElement) { return; }

            oFormElement.setVisible(bVisible);
            if (typeof oAnchorField.setVisible === "function") {
                oAnchorField.setVisible(bVisible);
            }

            var fnApplyDom = function () {
                var oDom = oFormElement.getDomRef();
                if (oDom) { oDom.style.display = bVisible ? "" : "none"; }
                var oFieldDom = oAnchorField.getDomRef && oAnchorField.getDomRef();
                if (oFieldDom) { oFieldDom.style.display = bVisible ? "" : "none"; }
            };

            fnApplyDom();
            setTimeout(fnApplyDom, 100);
        },

        _findActionDialogField: function (sParamName) {
            var aDialogs = Element.registry.filter(function (oControl) {
                return oControl.isA("sap.m.Dialog") && oControl.isOpen && oControl.isOpen();
            });

            for (var i = 0; i < aDialogs.length; i++) {
                var aMatches = aDialogs[i].findAggregatedObjects(true, function (oControl) {
                    return this._isParamControl(oControl, sParamName);
                }.bind(this));

                var oFieldMatch = aMatches.filter(function (oControl) {
                    return !oControl.isA("sap.ui.layout.form.FormElement") && !oControl.isA("sap.m.Label");
                })[0];

                if (oFieldMatch) { return oFieldMatch; }
                if (aMatches.length) { return aMatches[0]; }
            }
            return null;
        },
        _isParamControl: function (oControl, sParamName) {
            if (oControl.data && oControl.data(CONTRACT_END_FIELD_FLAG)) { return false; }

            if ((oControl.getId() || "").toLowerCase().indexOf(sParamName) !== -1) {
                return true;
            }
            if (!oControl.getBindingInfo) { return false; }

            var aProps = ["value", "selectedKey", "additionalValue", "dateValue"];
            return aProps.some(function (sProp) {
                var oInfo = oControl.getBindingInfo(sProp);
                var aParts = oInfo && (oInfo.parts || [oInfo]);
                return !!aParts && aParts.some(function (oPart) {
                    return oPart && oPart.path && oPart.path.toLowerCase().indexOf(sParamName) !== -1;
                });
            });
        },

        // [JHAH FIX LOG: ADDED VISIBILITY TOGGLE (bShow) AND CACHE UPDATE]
        _addContractEndDateField: function (oAnchorField, sValue, bShow) {
            var oFormElement = oAnchorField;
            while (oFormElement && !oFormElement.isA("sap.ui.layout.form.FormElement")) {
                oFormElement = oFormElement.getParent();
            }
            if (!oFormElement) { return; }

            var oContainer = oFormElement.getParent();
            if (!oContainer || !oContainer.insertFormElement) { return; }

            // 1. Check if the field was previously injected on a cached dialog
            var oExistingElement = null;
            var aElements = oContainer.getFormElements();
            for (var i = 0; i < aElements.length; i++) {
                if (aElements[i].data(CONTRACT_END_FIELD_FLAG)) {
                    oExistingElement = aElements[i];
                    break;
                }
            }

            // 2. If it exists, update text and force visibility
            if (oExistingElement) {
                console.log("[JHAH FIX LOG] _addContractEndDateField: Found Existing Field. Updating value and setting visibility to:", bShow);
                var oText = oExistingElement.getFields()[0];
                if (oText && typeof oText.setText === "function") {
                    oText.setText(sValue);
                }
                oExistingElement.setVisible(bShow);
                return;
            }

            // 3. If it doesn't exist, and we don't want to show it, do nothing!
            if (!bShow) {
                console.log("[JHAH FIX LOG] _addContractEndDateField: Field does not exist and should be hidden. Skipping creation.");
                return;
            }

            // 4. Create the new element and show it
            console.log("[JHAH FIX LOG] _addContractEndDateField: Creating New Field.");
            var oNewElement = new FormElement({
                label: new Label({ text: this._getText("contractEndDate", "Contract End Date") }),
                fields: [new Text({ text: sValue })]
            });
            oNewElement.data(CONTRACT_END_FIELD_FLAG, true);
            oNewElement.setVisible(bShow);

            oContainer.insertFormElement(oNewElement, oContainer.indexOfFormElement(oFormElement));
        }

    });
});